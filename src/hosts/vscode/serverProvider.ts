/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { characterCountOf } from './tokenCount';
import { CHARS_PER_TOKEN } from '../../engine/chat/usageReport';
import type { Log } from '../../engine/ports/host';
import type { StateStore } from '../../engine/ports/state';
import { modelInformationOf } from './modelMapping';
import { bodyOf } from './requestMapping';
import { listModels, ServerChatError, streamChat, type WireEvent, type WireUsage } from './serverClient';
import type { LinkState, ServerLink } from './serverLink';

/** The models a window last listed, kept so a server that is down or cold cannot empty the picker. */
export function savedModelsKey(agentId: string): string {
	return `acpHub.models.${agentId}`;
}

/** What the provider needs of the window's link to the server. */
export type ServerProviderLink = Pick<ServerLink, 'ensure' | 'state' | 'onDidChange'>;

export interface ServerProviderDeps {
	/** The agent whose models this provider publishes; the server reads it from the model id. */
	readonly agentId: string;
	/** The vendor the workbench registers the provider under. */
	readonly vendor: string;
	readonly link: ServerProviderLink;
	/** The store the listed models are saved in, so the next window shows them at once. */
	readonly state: StateStore;
	readonly log: Log;
	/** The window's own folder, which roots a chat whose folders this machine does not have. */
	windowFolder(): string;
}

/**
 * Publishes the models of one agent to Copilot Chat and carries each turn to
 * the server, which drives the agent. There is one provider per agent; every
 * difference between agents lives in the server's adapters, never here.
 */
export class ServerProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>, vscode.Disposable {

	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	private readonly unsubscribe: () => void;
	private listing: Promise<vscode.LanguageModelChatInformation[]> | undefined;
	private lastKind: LinkState['kind'] | undefined;
	private disposed = false;

	constructor(private readonly deps: ServerProviderDeps) {
		this.lastKind = deps.link.state?.kind;
		this.unsubscribe = deps.link.onDidChange(state => this.linkChanged(state));
	}

	get vendor(): string {
		return this.deps.vendor;
	}

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested) {
			return [];
		}
		const saved = this.savedModels();
		if (saved.length > 0) {
			// A cold server must not hold the picker: the models a window listed last are offered at once,
			// and the listing below refreshes them in the background when the server answers otherwise.
			this.listInBackground(saved);
			return saved;
		}
		return this.list(saved);
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}
		const controller = new AbortController();
		const subscription = token.onCancellationRequested(() => controller.abort());
		try {
			const state = await this.deps.link.ensure();
			if (state.kind !== 'ready') {
				throw new ServerChatError(`Could not reach the server: ${state.reason}`);
			}
			// A server that writes an error into the stream answers the turn with it, not with a broken reply.
			const failure: { message?: string } = {};
			await streamChat(state.endpoint, bodyOf(model, this.deps.agentId, messages, options, this.deps.windowFolder()), controller.signal, event => {
				if (event.type === 'error') {
					failure.message = event.message;
					return;
				}
				this.report(event, progress);
			});
			if (failure.message !== undefined) {
				throw new ServerChatError(failure.message);
			}
		} catch (error) {
			// A turn the window left is not a failure, and the chat shows nothing for it.
			if (controller.signal.aborted) {
				return;
			}
			this.deps.log(`The ${this.deps.agentId} chat failed: ${messageOf(error)}`, 'error');
			// The server may have gone with the turn; the next message finds or starts one.
			void this.deps.link.ensure();
			throw new vscode.LanguageModelError(messageOf(error));
		} finally {
			subscription.dispose();
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const characters = typeof value === 'string' ? value.length : characterCountOf(value);
		return Math.ceil(characters / CHARS_PER_TOKEN);
	}

	/**
	 * Resolves this provider's models in the workbench. The model picker of the
	 * Agents window only lists what the agent host advertises, and the host's
	 * BYOK bridge enumerates already-resolved models, so without this the models
	 * would never be published there.
	 */
	async publishModels(): Promise<void> {
		try {
			await vscode.lm.selectChatModels({ vendor: this.deps.vendor });
			this.deps.log(`Published the ${this.deps.agentId} models to the workbench.`, 'debug');
		} catch (error) {
			this.deps.log(`Could not publish the ${this.deps.agentId} models: ${messageOf(error)}`, 'error');
		}
	}

	/** Asks the workbench to list the models again, for example after an agent was installed, enabled or signed in. */
	refresh(): void {
		if (!this.disposed) {
			this.changeEmitter.fire();
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.unsubscribe();
		this.changeEmitter.dispose();
	}

	/** The models the server publishes for this agent, or the ones a window listed before. */
	private async list(saved: readonly vscode.LanguageModelChatInformation[]): Promise<vscode.LanguageModelChatInformation[]> {
		const state = await this.deps.link.ensure({ background: true });
		this.lastKind = state.kind;
		if (state.kind !== 'ready') {
			this.deps.log(`The server is unavailable (${state.reason}); offering the ${saved.length} saved ${this.deps.agentId} model(s).`, 'warn');
			return [...saved];
		}

		try {
			const wires = await listModels(state.endpoint);
			const models = wires
				.filter(model => model.owned_by === this.deps.agentId)
				.flatMap(model => modelInformationOf(this.deps.agentId, model));
			if (models.length === 0) {
				// A cold server or an agent that is not installed: an empty answer must not empty the picker.
				this.deps.log(`The server listed no ${this.deps.agentId} models; offering the ${saved.length} saved one(s) instead.`, 'warn');
				return [...saved];
			}
			if (saved.length > 0 && JSON.stringify(saved) !== JSON.stringify(models)) {
				// The save lands first, so the workbench that lists again on this news already sees them.
				await this.save(models);
				this.changeEmitter.fire();
				return models;
			}
			await this.save(models);
			return models;
		} catch (error) {
			this.deps.log(`Could not list the ${this.deps.agentId} models: ${messageOf(error)}`, 'warn');
			return [...saved];
		}
	}

	/** Lists once at a time, so a slow link cannot stack a request per picker redraw. */
	private listInBackground(saved: readonly vscode.LanguageModelChatInformation[]): void {
		if (this.listing || this.disposed) {
			return;
		}
		const work = this.list(saved);
		this.listing = work;
		void work.then(() => {
			if (this.listing === work) {
				this.listing = undefined;
			}
		});
	}

	private savedModels(): vscode.LanguageModelChatInformation[] {
		const saved = this.deps.state.get<vscode.LanguageModelChatInformation[]>(savedModelsKey(this.deps.agentId));
		return Array.isArray(saved) ? saved : [];
	}

	private async save(models: readonly vscode.LanguageModelChatInformation[]): Promise<void> {
		try {
			await this.deps.state.update(savedModelsKey(this.deps.agentId), models);
		} catch (error) {
			this.deps.log(`Could not save the ${this.deps.agentId} models: ${messageOf(error)}`, 'warn');
		}
	}

	/** A server that came or went changed what can be offered, so the workbench lists again. */
	private linkChanged(state: LinkState): void {
		if (this.disposed || state.kind === this.lastKind) {
			return;
		}
		this.lastKind = state.kind;
		this.changeEmitter.fire();
	}

	/** Reports one event of the reply as the part the chat renders. */
	private report(event: WireEvent, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
		switch (event.type) {
			case 'text':
				progress.report(new vscode.LanguageModelTextPart(event.text));
				return;
			case 'thought':
				reportThinking(progress, event.text);
				return;
			case 'tool-call':
				progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, (event.input ?? {}) as object));
				return;
			case 'usage':
				progress.report(vscode.LanguageModelDataPart.json(usageReportOf(event.usage), 'usage'));
				return;
			case 'error':
				// The caller turns it into the error the chat shows.
				return;
		}
	}
}

/** The figures of a turn, in the shape the chat already reads them in. */
function usageReportOf(usage: WireUsage): Record<string, unknown> {
	return {
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		prompt_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
		completion_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
	};
}

/** Reports a thinking chunk when the running VS Code exposes thinking parts. */
function reportThinking(progress: vscode.Progress<vscode.LanguageModelResponsePart>, text: string): void {
	const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => unknown }).LanguageModelThinkingPart;
	if (ThinkingPart) {
		progress.report(new ThinkingPart(text) as vscode.LanguageModelResponsePart);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
