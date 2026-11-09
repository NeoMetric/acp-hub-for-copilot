/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentAdapter, AgentSettings } from './adapter';
import { AdapterNotInstalledError } from '../engine/acp/agentClient';
import type { CancellationToken } from '../engine/acp/emitter';
import type { McpToolResult } from './bridge';
import type { RequestMeasurement } from './cache';
import { characterCountOf, readTranscriptOptions } from './convert';
import type { Log } from './logging';
import { modelsStateKey } from './modelInfo';
import { effortOf } from './models';
import { createRequestDump } from './requestDump';
import { resolveCwd, systemGuidanceOf, workspaceFoldersOf } from './requestContext';
import { createSessionPrompt, type PromptWorkspace } from './systemPrompt';
import { createVsCodeHost, rememberSent, sentOf } from '../hosts/vscode/host';
import { ChatError } from '../engine/chat/ChatError';
import { ChatService } from '../engine/chat/ChatService';
import type { FinishedTurn, ToolBridge } from '../engine/chat/types';
import type { ChatMessage, ChatRequest, Part, ToolDef, ToolResult } from '../engine/model/chat';
import type { StreamEvent } from '../engine/model/stream';
import type { HostPort } from '../engine/ports/host';
import type { ProviderDeps } from './provider/types';
import { ModelList } from './provider/modelList';
import { sessionKey } from './provider/keys';
import { CHARS_PER_TOKEN } from '../engine/chat/usageReport';

export { chatIdOf, chatLabelOf, guidanceChangeOf, guidanceDiffers, guidanceLineHashes, keepsSessionAfterFailure, sessionKey, toolsDiffer } from './provider/keys';
export type { AgentApi, FinishedTurn, ProviderDeps } from './provider/types';

/**
 * Publishes the models of one ACP agent to Copilot Chat and translates a
 * workbench request into the engine's own {@link ChatRequest}. There is one
 * provider per agent adapter; everything it does with a chat — sessions, reuse,
 * forks, tool continuation, idle release — belongs to the {@link ChatService}
 * it drives.
 */
export class AcpProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>, vscode.Disposable {

	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	private readonly turnEmitter = new vscode.EventEmitter<FinishedTurn>();
	/** Fires after a chat turn ended successfully, which spends plan limits. */
	readonly onDidFinishTurn = this.turnEmitter.event;

	private readonly signInEmitter = new vscode.EventEmitter<void>();
	/** Fires when the agent refused a request for lack of credentials, so the account is known to be signed out. */
	readonly onDidRequireSignIn = this.signInEmitter.event;

	private readonly requestEmitter = new vscode.EventEmitter<RequestMeasurement>();
	/** Fires after each model call of a running turn, for agents that report each call. */
	readonly onDidMeasureRequest = this.requestEmitter.event;

	private readonly service: ChatService;
	private readonly log: Log;
	private readonly models: ModelList;
	private readonly host: HostPort;
	private dumpRequest: ReturnType<typeof createRequestDump> | undefined;
	private signInWarningShown = false;
	private disposed = false;

	constructor(
		private readonly adapter: AgentAdapter,
		private readonly deps: ProviderDeps,
	) {
		this.log = deps.log;
		this.host = deps.host ?? createVsCodeHost({
			log: deps.log,
			state: deps.state,
			storageRoot: '',
			windowFolder: () => this.service.workspaceFolder,
			agentName: () => adapter.displayName,
			signIn: id => deps.signIn(id),
			showOutput: () => deps.showOutput(),
		});
		this.service = new ChatService({
			adapter,
			host: this.host,
			bridge: this.bridge(),
			resolveLaunch: () => deps.resolveLaunch(),
			createClient: deps.createClient && ((adapter, ctx, clientDeps) => deps.createClient!(adapter, ctx, clientDeps)),
			client: deps.client,
			buildSessionPrompt: (tools, folders, guidance) => this.buildSessionPrompt(tools, folders, guidance),
			transcriptOptions: () => readTranscriptOptions(this.host.settings),
			dumpRequest: (request, settings) => this.recordRequest(request, settings),
			refineWindow: (model, size) => this.models?.refineWindow(model, size),
			finished: turn => this.turnEmitter.fire(turn),
			measured: measurement => this.requestEmitter.fire(measurement),
			signInRequired: () => this.promptSignIn(),
			agentChanged: change => {
				if (change === 'restarted') {
					// The account may have changed, and with it the models on offer and their windows.
					this.models.reset();
					this.signInWarningShown = false;
					this.changeEmitter.fire();
				}
			},
			isEnabled: () => this.deps.isEnabled?.() !== false,
		});
		this.models = new ModelList({
			adapter,
			state: deps.state,
			log: deps.log,
			agentClient: () => this.service.client(),
			warmSession: () => this.service.openWarmSession(),
			agentUsed: () => this.service.touch(),
			isSignInRequired: error => this.service.needsSignIn(error),
			promptSignIn: () => this.service.requestSignIn(),
			changed: () => this.changeEmitter.fire(),
		}, modelsStateKey(adapter.id));
	}

	get vendor(): string {
		return this.adapter.vendor;
	}

	/** The engine use case this provider drives. */
	get chat(): ChatService {
		return this.service;
	}

	provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		if (this.deps.isEnabled?.() === false) {
			return Promise.resolve([]);
		}
		return this.models.provide(options, token);
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
		try {
			const request = this.toRequest(model, messages, options);
			const controller = new AbortController();
			const subscription = token.onCancellationRequested(() => controller.abort());
			try {
				await this.service.respond(request, event => this.report(event, progress), controller.signal);
			} finally {
				subscription.dispose();
			}
		} catch (error) {
			this.log(`Language model request failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
			if (error instanceof AdapterNotInstalledError) {
				throw new vscode.LanguageModelError(error.message);
			}
			if (error instanceof ChatError) {
				throw new vscode.LanguageModelError(error.message);
			}
			throw error;
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const characters = typeof value === 'string' ? value.length : characterCountOf(value);
		return Math.ceil(characters / CHARS_PER_TOKEN);
	}

	/** Starts the agent to let its own browser sign-in flow run. */
	startForSignIn(methodId?: string): Promise<boolean> {
		return this.service.startForSignIn(methodId);
	}

	/** Restarts the agent process; the provider's caches are reset with it. */
	async restart(): Promise<void> {
		await this.service.restart();
	}

	/** Forgets how the agent was launched, so the next request reads its settings and key again. */
	invalidateLaunch(): void {
		this.service.invalidateLaunch();
	}

	/** Forgets the models and asks the workbench to list them again, for example after the agent was installed or signed in. */
	refresh(): void {
		this.models.forget();
		this.changeEmitter.fire();
	}

	/**
	 * Resolves this provider's models in the workbench. The model picker of the
	 * Agents window only lists what the agent host advertises, and the host's
	 * BYOK bridge enumerates already-resolved models, so without this the models
	 * would never be published there.
	 */
	async publishModels(): Promise<void> {
		try {
			await vscode.lm.selectChatModels({ vendor: this.adapter.vendor });
			this.log('Published models to the workbench.', 'debug');
		} catch (error) {
			this.log(`Could not publish models: ${this.describe(error)}`, 'error');
		}
	}

	/** Starts the agent and opens the warm session; `false` when the agent is not installed. */
	async prepareAgent(): Promise<boolean> {
		try {
			await this.service.warm();
		} catch (error) {
			if (error instanceof AdapterNotInstalledError) {
				return false;
			}
			throw error;
		}
		return true;
	}

	/** Starts the agent again, with its warm session, when the idle shutdown stopped it and the user is back in the window. */
	wakeAfterIdle(): void {
		this.service.wakeAfterIdle();
	}

	/** Sends one prompt to the warm session and returns the reply text, or `undefined` when the agent is not installed. */
	askAgent(prompt: string): Promise<string | undefined> {
		return this.service.askAgent(prompt);
	}

	/** Cancels every running turn and closes every chat session; the agent process stays for the chats that follow. */
	closeAllSessions(): Promise<void> {
		return this.service.closeAllSessions();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.models.dispose();
		this.service.dispose();
		this.changeEmitter.dispose();
		this.turnEmitter.dispose();
		this.signInEmitter.dispose();
		this.requestEmitter.dispose();
	}

	/** Builds the engine's request from what the workbench sent. */
	private toRequest(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
	): ChatRequest {
		const folders = workspaceFoldersOf(messages);
		const request: ChatRequest = {
			chatId: sessionKey(messages, options),
			// The folder the request names, when this machine has it. The window's folder is
			// added when the engine asks for the chat, by which time the agent's launch is read.
			cwd: resolveCwd(folders, ''),
			messages: messages.map(toChatMessage),
			tools: (options.tools ?? []).map(toToolDef),
			model: model.id,
			effort: effortOf(options),
			systemGuidance: systemGuidanceOf(messages),
		};
		rememberSent(request, { messages, options });
		return request;
	}

	/** Reports one engine event to the workbench as the part it renders. */
	private report(event: StreamEvent, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
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
				progress.report(vscode.LanguageModelDataPart.json({
					prompt_tokens: event.promptTokens,
					completion_tokens: event.outputTokens,
					total_tokens: event.promptTokens + event.outputTokens,
					prompt_tokens_details: { cached_tokens: event.cachedTokens },
					completion_tokens_details: { reasoning_tokens: event.reasoningTokens ?? 0 },
				}, 'usage'));
				return;
			default:
				return;
		}
	}

	/** Records the request for inspection when the user turned that on for this agent. */
	private recordRequest(request: ChatRequest, settings: AgentSettings | undefined): void {
		if (settings?.dumpRequests !== true || !this.deps.requestDumpDir) {
			return;
		}
		const sent = sentOf(request);
		if (!sent) {
			return;
		}
		this.dumpRequest ??= createRequestDump(this.deps.requestDumpDir, this.log);
		this.dumpRequest(request.chatId, sent.messages, sent.options);
	}

	/** A chat still starts when the customization files cannot be read; it just has no extras. */
	private async buildSessionPrompt(tools: readonly ToolDef[], chatFolders: readonly string[] | undefined, guidance: string | undefined): Promise<string | undefined> {
		this.sessionPrompt ??= createSessionPrompt(this.log, this.adapter.systemPrompt, vsCodeWorkspace, this.deps.profilePromptsDir);
		return this.sessionPrompt(tools, chatFolders, guidance);
	}

	private sessionPrompt: ReturnType<typeof createSessionPrompt> | undefined;

	/** The tool bridge as the engine sees it: neutral tools in, neutral results out. */
	private bridge(): ToolBridge {
		const bridge = this.deps.bridge;
		return {
			registerSession: (tools, execute, options) => bridge.registerSession(
				tools,
				async (name, input, token): Promise<McpToolResult | undefined> => {
					const result = await execute(name, input, toAbortSignal(token));
					return result && { content: result.content.map(toWorkbenchPart), isError: result.isError };
				},
				options,
			),
			updateTools: (token, tools) => bridge.updateTools(token, tools),
			unregisterSession: token => bridge.unregisterSession(token),
		};
	}

	private promptSignIn(): void {
		this.signInEmitter.fire();
		if (this.signInWarningShown) {
			return;
		}
		this.signInWarningShown = true;
		this.host.ui.requestSignIn(this.adapter.id);
	}

	private describe(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Reports a thinking chunk when the running VS Code exposes thinking parts. */
function reportThinking(progress: vscode.Progress<vscode.LanguageModelResponsePart>, text: string): void {
	const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => unknown }).LanguageModelThinkingPart;
	if (ThinkingPart) {
		progress.report(new ThinkingPart(text) as vscode.LanguageModelResponsePart);
	}
}

/** The window's folders and file locations, which the engine is given rather than asking for. */
function vsCodeWorkspace(): PromptWorkspace {
	const chat = vscode.workspace.getConfiguration('chat');
	return {
		trusted: vscode.workspace.isTrusted,
		windowFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
		locations: {
			instructions: chat.get<Record<string, boolean>>('instructionsFilesLocations'),
			prompt: chat.get<Record<string, boolean>>('promptFilesLocations'),
		},
	};
}

/** One workbench message as the engine's own. */
function toChatMessage(message: vscode.LanguageModelChatRequestMessage): ChatMessage {
	return {
		role: message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system',
		name: message.name,
		parts: message.content.flatMap(toParts),
	};
}

function toParts(part: unknown): Part[] {
	if (typeof part === 'string') {
		return [{ type: 'text', text: part }];
	}
	if (part instanceof vscode.LanguageModelTextPart) {
		return [{ type: 'text', text: part.value }];
	}
	if (part instanceof vscode.LanguageModelDataPart) {
		return part.mimeType.startsWith('image/') ? [{ type: 'image', data: part.data, mimeType: part.mimeType }] : [];
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return [{ type: 'tool-call', callId: part.callId, name: part.name, input: part.input }];
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return [{ type: 'tool-result', callId: part.callId, content: (part.content as readonly unknown[]).flatMap(toParts), isError: (part as unknown as { isError?: boolean }).isError === true }];
	}
	return [];
}

/** One tool of the request as the engine's own. */
function toToolDef(tool: vscode.LanguageModelChatTool): ToolDef {
	return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/** One part of a tool result as the workbench takes it back. */
function toWorkbenchPart(part: Part): unknown {
	switch (part.type) {
		case 'text':
			return new vscode.LanguageModelTextPart(part.text);
		case 'image':
			return new vscode.LanguageModelDataPart(part.data, part.mimeType);
		case 'tool-result':
			return new vscode.LanguageModelTextPart(part.content.map(item => item.type === 'text' ? item.text : '').join('\n'));
		default:
			return new vscode.LanguageModelTextPart(JSON.stringify(part.input ?? {}));
	}
}

/** A cancellation the engine reports as the plain signal the rest of the engine watches. */
function toAbortSignal(token: CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}

export type { ToolResult };
