/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentAdapter, ModelChoice, ModelPolicy } from '../adapter';
import { AdapterNotInstalledError, type AgentSession } from '../agentClient';
import type { Log } from '../logging';
import { acpModelValue, effortLevelsOf, findModelOption, flattenChoices, toModelVariants } from '../models';
import { describe, rpcDetailsOf } from './sessionOptions';
import type { AgentApi } from './types';

const MODEL_RETRY_BASE_MS = 5_000;
const MODEL_RETRY_MAX_MS = 2 * 60_000;
const MODEL_RETRY_LIMIT = 6;

/**
 * The models a session offers, as the picker lists them. Returns `undefined`
 * when the agent reported no model option, so nothing can be offered.
 */
export function modelsOfSession(adapter: AgentAdapter, session: AgentSession, log: Log): vscode.LanguageModelChatInformation[] | undefined {
	const modelOption = findModelOption(session.configOptions);
	if (!modelOption) {
		log('The agent did not report a model config option; no models can be offered.', 'warn');
		return undefined;
	}

	let choices = flattenChoices(modelOption.options ?? []);
	// A fresh session may report no effort option, only bracketed `model[effort]`
	// ids: until a model is resolved, the catalogue is the only source.
	const reported = effortLevelsOf(adapter.modelPolicy, session.configOptions);
	const effortLevels = reported.length > 0 ? reported : adapter.modelPolicy.effortLevelsFromModels?.(session.models?.availableModels ?? []) ?? [];

	if (adapter.listModels) {
		const offered = choices.map((choice): ModelChoice => ({ value: choice.value, name: choice.name, description: choice.description ?? undefined }));
		choices = adapter.listModels({ models: offered, effortLevels }).map(choice => ({ value: choice.value, name: choice.name, description: choice.description }));
	}

	const models = toModelVariants(adapter.modelPolicy, choices, effortLevels);
	log(`Offering ${choices.length} ${adapter.displayName} model(s) for chat and ${choices.length} for the Copilot agent: ${choices.map(choice => choice.value).join(', ')}`);
	log(`Thinking effort levels reported by the agent: ${effortLevels.join(', ') || 'none'}`);
	return models;
}

/**
 * The models with the context windows the agent measured. A turn reports the
 * real size in `usage_update.size`, which is the only measurement there is;
 * before one has, the policy's window stands. Unchanged models are returned as
 * they are, so the caller can tell whether anything moved.
 */
export function withReportedWindows(models: readonly vscode.LanguageModelChatInformation[], policy: ModelPolicy, reportedWindows: ReadonlyMap<string, number>): vscode.LanguageModelChatInformation[] {
	return models.map(model => {
		const bare = acpModelValue(model.id);
		const window = reportedWindows.get(bare) ?? policy.contextWindowOf(bare, model.name);
		const maxInputTokens = window - policy.maxOutputTokens;
		return maxInputTokens === model.maxInputTokens ? model : { ...model, maxInputTokens };
	});
}

/** What the model list needs from the provider that owns it. */
export interface ModelListHost {
	adapter: AgentAdapter;
	state: vscode.Memento | undefined;
	log: Log;
	agentClient(): Promise<AgentApi>;
	/** The warm session the models are read from. */
	warmSession(): Promise<AgentSession>;
	/** Notes that the agent was used, for the idle shutdown. */
	agentUsed(): void;
	isSignInRequired(error: unknown): boolean;
	promptSignIn(): void;
	/** Tells the workbench to list the models again. */
	changed(): void;
}

/** The models shown in the picker: looked up through the agent, cached, saved and kept fresh. */
export class ModelList {

	private cached: vscode.LanguageModelChatInformation[] | undefined;
	/** The context size each model reported in `usage_update.size`, by bare model id, so the picker can show it. */
	private readonly reportedWindows = new Map<string, number>();
	private retryTimer: NodeJS.Timeout | undefined;
	private retryAttempt = 0;
	private refreshing = false;
	private disposed = false;

	constructor(private readonly host: ModelListHost, private readonly stateKey: string) { }

	async provide(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested) {
			return [];
		}
		if (this.cached) {
			return this.withWindows(this.cached);
		}

		// Models saved by an earlier run or another window show up at once; the agent
		// confirms them in the background, so a slow or failed start cannot empty the picker.
		const stored = this.host.state?.get<vscode.LanguageModelChatInformation[]>(this.stateKey);
		if (stored && stored.length > 0) {
			this.cached = stored;
			void this.refresh();
			return this.withWindows(stored);
		}

		return this.lookup(options);
	}

	/** Forgets the models, so the next request looks them up again. */
	forget(): void {
		this.cached = undefined;
		this.retryAttempt = 0;
	}

	/** Forgets everything the agent told about its models, for example after a restart (the account may have changed). */
	reset(): void {
		this.cached = undefined;
		this.reportedWindows.clear();
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retryTimer);
	}

	private async lookup(options: { readonly silent?: boolean }): Promise<vscode.LanguageModelChatInformation[]> {
		const { adapter, log } = this.host;
		try {
			const agent = await this.host.agentClient();
			await agent.ensureStarted();
			this.host.agentUsed();
			const warm = await this.host.warmSession();
			// A logged-out agent still lists its models; chatting is what fails. Say so up front.
			if (agent.requiresSignIn && !options.silent) {
				this.host.promptSignIn();
			}

			const models = modelsOfSession(adapter, warm, log);
			if (!models) {
				return [];
			}
			this.cached = models;
			this.retryAttempt = 0;
			void this.host.state?.update(this.stateKey, models);
			return this.withWindows(models);
		} catch (error) {
			if (error instanceof AdapterNotInstalledError) {
				log('The agent is not installed yet; no models are offered until it is installed from the ACP Hub sidebar.', 'debug');
				return [];
			}
			log(`Could not list ${adapter.displayName} models: ${describe(error)}`, 'error');
			const details = rpcDetailsOf(error);
			if (details) {
				// The agent's own explanation (a config error names paths), so debug only.
				log(`The agent's explanation: ${details}`, 'debug');
			}
			if (this.host.isSignInRequired(error)) {
				if (!options.silent) {
					this.host.promptSignIn();
				}
			} else {
				this.scheduleRetry();
				if (!options.silent) {
					void vscode.window.showWarningMessage(
						`${adapter.displayName} could not reach its agent: ${describe(error)} See the ACP Hub output channel for details.`
					);
				}
			}
			return [];
		}
	}

	/** Looks the models up through the agent and tells the workbench when they differ from the cached ones. */
	private async refresh(): Promise<void> {
		if (this.refreshing || this.disposed) {
			return;
		}
		this.refreshing = true;
		try {
			const previous = JSON.stringify(this.cached);
			const fresh = await this.lookup({ silent: true });
			// An empty result means the lookup failed or found nothing; what was shown stays.
			if (fresh.length > 0 && JSON.stringify(fresh) !== previous && !this.disposed) {
				this.host.changed();
			}
		} finally {
			this.refreshing = false;
		}
	}

	private withWindows(models: readonly vscode.LanguageModelChatInformation[]): vscode.LanguageModelChatInformation[] {
		return withReportedWindows(models, this.host.adapter.modelPolicy, this.reportedWindows);
	}

	/**
	 * Remembers the context size a turn reported and republishes the model when
	 * that changes the window the picker advertises. A size the model already
	 * shows fires nothing, so a turn cannot start a republish loop.
	 */
	refineWindow(modelId: string, size: number): void {
		const bare = acpModelValue(modelId);
		const maxInputTokens = size - this.host.adapter.modelPolicy.maxOutputTokens;
		if (maxInputTokens <= 0 || this.reportedWindows.get(bare) === size) {
			return;
		}
		this.reportedWindows.set(bare, size);
		const models = this.cached;
		const refined = models ? this.withWindows(models) : undefined;
		if (!models || !refined || refined.every((model, index) => model === models[index])) {
			return;
		}
		this.cached = refined;
		void this.host.state?.update(this.stateKey, refined);
		this.host.log(`The agent reported a ${size}-token context window for ${bare}: the model now advertises ${maxInputTokens} input tokens.`);
		if (!this.disposed) {
			this.host.changed();
		}
	}

	/** Tries the lookup again later, with growing pauses, so a failed start heals without a manual refresh. */
	private scheduleRetry(): void {
		if (this.disposed || this.retryTimer || this.retryAttempt >= MODEL_RETRY_LIMIT) {
			return;
		}
		const delayMs = Math.min(MODEL_RETRY_BASE_MS * 3 ** this.retryAttempt, MODEL_RETRY_MAX_MS);
		this.retryAttempt++;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.disposed || this.cached) {
				return;
			}
			this.host.log(`Retrying the model lookup (attempt ${this.retryAttempt} of ${MODEL_RETRY_LIMIT}).`);
			void this.lookup({ silent: true })
				.then(models => {
					if (models.length > 0 && !this.disposed) {
						this.host.changed();
					}
				});
		}, delayMs);
		this.retryTimer.unref();
	}
}
