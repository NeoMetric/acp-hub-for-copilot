/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { AgentAdapter, AgentSettings, LaunchContext } from './adapter';
import { AdapterNotInstalledError, AgentClient, type AgentChange, type AgentSession, type CreateSessionOptions } from './agentClient';
import type { McpToolResult } from './bridge';
import type { RequestMeasurement } from './cache';
import { carriesToolResults, characterCountOf, diverged, fingerprint, lastUserMessageIndex, userWordsAfterReply } from './convert';
import type { Log } from './logging';
import { acpModelValue, effortOf } from './models';
import { createRequestDump, summarizeRequest } from './requestDump';
import { isAuthRequiredError } from './rpc';
import { SavedSessionStore, toolsHashOf } from './sessionStore';
import { createSessionPrompt } from './systemPrompt';
import { buildPromptBlocks } from './provider/assemble';
import { clearToolDeadline, disposeCancellations, failPendingToolCalls, handOverToolCall, resolveToolResults } from './provider/heldCalls';
import { agentIdleMs, IDLE_SWEEP_MS, idleTimeoutMs, MAX_CHAT_SESSIONS, WARM_SESSION_IDLE_MS } from './provider/idle';
import { chatContextOf, chatIdOf, chatLabelOf, guidanceDiffers, guidanceHashOf, sessionKey, toolsDiffer } from './provider/keys';
import { ModelList } from './provider/modelList';
import { findReusable, promptHashOf } from './provider/reuse';
import { applyEffort, applyModel, describe, switchModelInPlace } from './provider/sessionOptions';
import { TurnRunner } from './provider/turns';
import type { AgentApi, ChatContext, ChatSession, FinishedTurn, ProviderDeps, Reuse } from './provider/types';
import { CHARS_PER_TOKEN } from './provider/usageReport';
import { bridgeServer, WarmSession } from './provider/warmSession';

export { chatIdOf, chatLabelOf, guidanceChangeOf, guidanceDiffers, guidanceLineHashes, keepsSessionAfterFailure, sessionKey, toolsDiffer } from './provider/keys';
export type { AgentApi, FinishedTurn, ProviderDeps } from './provider/types';

/** Per-process nonce, so call ids from an earlier run in a chat's history never match a new call. */
const TOOL_CALL_ID_PREFIX = `acp-hub-${randomBytes(4).toString('hex')}-`;

/**
 * Publishes the models of one ACP agent to Copilot Chat and drives one ACP
 * session per chat. There is one provider per agent adapter; it owns the
 * agent's process (through an {@link AgentClient}) and shares nothing with the
 * providers of other agents.
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

	private readonly sessions = new Map<string, ChatSession>();
	private readonly saved: SavedSessionStore;
	private readonly log: Log;
	private client: AgentApi | undefined;
	private clientListener: vscode.Disposable | undefined;
	/** What the agent was last launched with; the settings are read from it. */
	private launch: LaunchContext | undefined;
	private dumpRequest: ReturnType<typeof createRequestDump> | undefined;
	private sessionPrompt: ReturnType<typeof createSessionPrompt> | undefined;
	private readonly models: ModelList;
	private readonly warm: WarmSession;
	private readonly turns: TurnRunner;
	private toolCallSeq = 0;
	/** When the agent was last asked for anything or let go of a session; the idle shutdown counts from here. */
	private lastAgentUse = Date.now();
	/** Sessions being closed, so a request for the same chat waits until the agent has let go of the session. */
	private readonly closing = new Map<string, Promise<void>>();
	private sweepTimer: NodeJS.Timeout | undefined;
	private signInWarningShown = false;
	private knownBrowserSignIn: boolean | undefined;
	private disposed = false;

	constructor(
		private readonly adapter: AgentAdapter,
		private readonly deps: ProviderDeps,
	) {
		this.log = deps.log;
		this.saved = new SavedSessionStore(deps.state, `acpHub.savedSessions.${adapter.id}`);
		this.warm = new WarmSession({
			adapter,
			bridge: deps.bridge,
			agentClient: () => this.agentClient(),
			cwd: () => this.launch?.workspaceFolder ?? '',
			opened: () => this.scheduleIdleSweep(),
		});
		this.models = new ModelList({
			adapter,
			state: deps.state,
			log: deps.log,
			agentClient: () => this.agentClient(),
			warmSession: () => this.ensureWarmSession(),
			agentUsed: () => {
				this.lastAgentUse = Date.now();
				this.scheduleIdleSweep();
			},
			isSignInRequired: error => this.isSignInRequired(error),
			promptSignIn: () => this.promptSignIn(),
			changed: () => this.changeEmitter.fire(),
		}, `acpHub.models.${adapter.id}`);
		this.turns = new TurnRunner({
			adapter,
			log: deps.log,
			models: this.models,
			saved: this.saved,
			agent: () => this.agent,
			finished: turn => this.turnEmitter.fire(turn),
			measured: measurement => this.requestEmitter.fire(measurement),
			destroySession: key => this.destroySession(key),
			isSignInRequired: error => this.isSignInRequired(error),
			promptSignIn: () => this.promptSignIn(),
			needsCredentials: () => this.needsCredentials(),
		});
	}

	get vendor(): string {
		return this.adapter.vendor;
	}

	private get settings(): AgentSettings | undefined {
		return this.launch?.settings;
	}

	/** Whether the agent reports the usage of each model call, not only of the turn. */
	private get reportsEachModelCall(): boolean {
		return this.adapter.modelCallUsage !== undefined;
	}

	/**
	 * The agent client, created on first use from the launch context. An agent
	 * that is not installed has no launch context, which says so right away
	 * instead of waiting for a process that will never come.
	 */
	private async agentClient(): Promise<AgentApi> {
		const ctx = await this.deps.resolveLaunch();
		if (!ctx) {
			throw new AdapterNotInstalledError(this.adapter.displayName);
		}
		this.launch = ctx;
		if (this.client) {
			await this.client.updateContext(ctx);
			return this.client;
		}
		const client = this.deps.createClient
			? this.deps.createClient(this.adapter, ctx, this.deps.client)
			: new AgentClient(this.adapter, ctx, this.deps.client);
		this.client = client;
		this.clientListener = client.onDidChange(change => this.handleAgentChange(change));
		return client;
	}

	/** The client of a session that exists; only called once {@link agentClient} has run. */
	private get agent(): AgentApi {
		if (!this.client) {
			throw new AdapterNotInstalledError(this.adapter.displayName);
		}
		return this.client;
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
			await this.respond(model, messages, options, progress, token);
		} catch (error) {
			if (error instanceof AdapterNotInstalledError) {
				throw new vscode.LanguageModelError(error.message);
			}
			throw error;
		}
	}

	private async respond(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		await this.agentClient();

		this.lastAgentUse = Date.now();
		const tools = options.tools ?? [];
		const key = sessionKey(messages, options);
		const context = chatContextOf(messages, this.launch?.workspaceFolder ?? '');
		this.recordRequest(key, messages, options);
		const effort = effortOf(options);
		const toolNames = tools.map(tool => tool.name);
		this.log(`Request shape: ${summarizeRequest(messages, options)}`, 'debug');
		this.log(`Request from Copilot: model ${model.id}, ${messages.length} message(s), ${tools.length} tool(s): ${toolNames.join(', ') || 'none'}`);
		// A session released a moment ago must be gone from the agent before it is resumed.
		await this.closing.get(key);
		let session = this.sessions.get(key);
		if (session) {
			// Re-insert so the map stays ordered by recency of use.
			this.sessions.delete(key);
			this.sessions.set(key, session);
			session.lastActive = Date.now();
		}

		if (session && session.model !== model.id) {
			await this.turns.abort(session);
			session = await this.switchModel(key, session, model, tools, context);
		}
		const fingerprints = messages.map(fingerprint);
		const lastUser = lastUserMessageIndex(messages);

		// Copilot ran the tools of the pending turn: hand the results back to the
		// agent and keep streaming the same turn into this response. The tools of the
		// session stay as they are until the turn ends, so a result is never dropped.
		// A message the user typed while the turn ran comes next to those results. As
		// natively, it ends the turn and starts a new one, so it falls through below.
		const userWords = session?.turn ? userWordsAfterReply(messages) : [];
		if (session && session.turn && userWords.length === 0 && resolveToolResults(session.turn, messages, this.log)) {
			this.markSeen(session, fingerprints);
			this.applyTools(session, tools);
			await applyEffort(this.agent, this.adapter.modelPolicy, session, effort, this.log);
			await this.turns.drive(key, session, progress, token, fingerprints, lastUser);
			return;
		}
		// The result of a call that already ended, such as one that timed out: the agent
		// went on without it, so the running turn is still the one to answer this request.
		if (session && session.turn && !session.turn.finished && userWords.length === 0 && carriesToolResults(messages)) {
			if (session.turn.pending.size > 0 && session.turn.held.length === 0) {
				await this.turns.abort(session);
				throw new vscode.LanguageModelError("A tool result could not be matched to the pending call. Please retry your request.");
			}
			this.log(`Late tool results for ${key}; the turn is still running, so this response continues it.`);
			this.markSeen(session, fingerprints);
			this.applyTools(session, tools);
			await applyEffort(this.agent, this.adapter.modelPolicy, session, effort, this.log);
			await this.turns.drive(key, session, progress, token, fingerprints, lastUser);
			return;
		}
		if (session?.turn) {
			this.log(`The pending turn for ${key} was abandoned; cancelling it.`, 'warn');
			await this.turns.abort(session);
		}

		if (session && tools.length > 0 && (!session.hasPrompt || toolsDiffer(session.openedTools, tools) || guidanceDiffers(session.context.guidance, context.guidance))) {
			// The chat was opened by a request that offered no tools, such as a title,
			// and so got no workspace prompt; or Copilot now offers a tool this session
			// never saw, or describes the chat differently. The agent takes its prompt and
			// its tools when it opens a session, so the chat gets a new one; its messages
			// are restored into it.
			this.log(`Chat ${key} ${session.hasPrompt ? 'changed its tools or its guidance' : 'now offers tools'}; giving it a new session.`);
			await this.destroySession(key);
			session = undefined;
		}
		if (!session) {
			const reuse = tools.length > 0 ? findReusable(this.saved, key, fingerprints, lastUser, tools, context, this.adapter.forkChats === true, this.log) : undefined;
			session = await this.createChatSession(key, model, tools, context, reuse, effort);
		}
		this.applyTools(session, tools);
		await applyEffort(this.agent, this.adapter.modelPolicy, session, effort, this.log);

		// A session that has seen nothing yet only gets the current turn, plus a
		// transcript of what came before: the chat may predate this session (window
		// reload, agent restart), and the agent has no other memory of it.
		let startIndex = session.history.length === 0 ? lastUser : session.history.length;
		let restoreContext = session.history.length === 0;

		if (session.history.length > fingerprints.length || diverged(session.history, fingerprints)) {
			this.log(`Chat history changed for ${key}; starting a fresh ACP session.`);
			await this.destroySession(key);
			session = await this.createChatSession(key, model, tools, context, undefined, effort);
			this.applyTools(session, tools);
			await applyEffort(this.agent, this.adapter.modelPolicy, session, effort, this.log);
			startIndex = lastUser;
			restoreContext = true;
		}

		const blocks = buildPromptBlocks(messages, startIndex, lastUser, restoreContext, session, this.log);
		if (blocks.length === 0) {
			this.log(`The request contained no user text to forward to ${this.adapter.displayName}.`, 'warn');
			throw new vscode.LanguageModelError(`There is no user message to send to ${this.adapter.displayName}.`);
		}

		// The agent has been given everything up to here. A turn that never finishes, because
		// the chat was abandoned, is cancelled by the next request, which then looks
		// like the start of the chat and sends the first message again.
		this.markSeen(session, fingerprints);
		session.chat ??= { id: chatIdOf(messages, options), label: chatLabelOf(messages), workspace: session.context.cwd };
		session.turn = this.turns.start(session, progress, token, blocks);
		await this.turns.drive(key, session, progress, token, fingerprints, lastUser);
	}

	/** Records the request for inspection when the user turned that on for this agent. */
	private recordRequest(key: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions): void {
		if (this.settings?.dumpRequests !== true || !this.deps.requestDumpDir) {
			return;
		}
		this.dumpRequest ??= createRequestDump(this.deps.requestDumpDir, this.log);
		this.dumpRequest(key, messages, options);
	}

	/** Records that the agent has been given every message of this request. */
	private markSeen(session: ChatSession, fingerprints: readonly string[]): void {
		session.history.length = 0;
		session.history.push(...fingerprints);
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const characters = typeof value === 'string' ? value.length : characterCountOf(value);
		return Math.ceil(characters / CHARS_PER_TOKEN);
	}

	/** Returns the account state reported by the agent, when available. */
	signInState(): boolean | undefined {
		const status = this.client?.lastAuthStatus as { kind?: unknown } | undefined;
		if (status?.kind === 'none' || this.client?.requiresSignIn) { return false; }
		if (typeof status?.kind === 'string') { return true; }
		return this.knownBrowserSignIn;
	}

	/** Starts the agent to let its own browser sign-in flow run. */
	async startForSignIn(methodId?: string): Promise<boolean> {
		const agent = await this.agentClient();
		await agent.restart();
		if (methodId) {
			await agent.signInWithMethod(methodId);
		} else {
			await agent.ensureStarted();
		}
		this.knownBrowserSignIn = !agent.requiresSignIn;
		return this.knownBrowserSignIn;
	}

	/** Restarts the agent process; the provider's caches are reset with it. */
	async restart(): Promise<void> {
		await this.client?.restart();
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
			this.log('Published models to the workbench.');
		} catch (error) {
			this.log(`Could not publish models: ${describe(error)}`, 'error');
		}
	}

	/**
	 * Sends one prompt to the warm session and returns the reply text, or
	 * `undefined` when the agent is not installed. Usage sources use it for
	 * commands the agent answers itself, which cost no model call.
	 */
	async askAgent(prompt: string): Promise<string | undefined> {
		try {
			await this.agentClient();
		} catch (error) {
			if (error instanceof AdapterNotInstalledError) {
				return undefined;
			}
			throw error;
		}
		const warm = await this.ensureWarmSession();
		let reply = '';
		await this.agent.prompt(warm.sessionId, [{ type: 'text', text: prompt }], {
			onText: text => {
				reply += text;
			},
		});
		this.warm.touch();
		return reply;
	}

	/** Cancels every running turn and closes every chat session. */
	async closeAllSessions(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map(key => this.destroySession(key)));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		clearTimeout(this.sweepTimer);
		this.models.dispose();
		this.clientListener?.dispose();
		this.changeEmitter.dispose();
		this.turnEmitter.dispose();
		this.signInEmitter.dispose();
		this.requestEmitter.dispose();
		void this.closeAllSessions();
		this.warm.release();
		this.client?.dispose();
	}

	private ensureWarmSession(): Promise<AgentSession> {
		this.lastAgentUse = Date.now();
		return this.warm.ensure();
	}

	/** Arms the sweep for idle sessions; it re-arms itself for as long as a session is left to watch. */
	private scheduleIdleSweep(): void {
		if (this.disposed || this.sweepTimer) {
			return;
		}
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = undefined;
			this.releaseIdleSessions();
			this.stopIdleAgent();
			if (this.sessions.size > 0 || this.warm.current || (this.client?.isRunning && agentIdleMs(this.settings) > 0)) {
				this.scheduleIdleSweep();
			}
		}, IDLE_SWEEP_MS);
		this.sweepTimer.unref();
	}

	/**
	 * Gives back the sessions nobody is using. A session with a turn is never
	 * released, including one waiting for Copilot to run a tool. A released chat
	 * is picked up again from its stored conversation on its next request.
	 */
	private releaseIdleSessions(): void {
		const now = Date.now();
		const idleMs = idleTimeoutMs(this.settings);
		if (idleMs > 0) {
			for (const [key, session] of [...this.sessions]) {
				if (!session.turn && this.client?.hasBackgroundTasks(session.acp.sessionId)) {
					session.lastActive = now;
					continue;
				}
				if (!session.turn && now - session.lastActive >= idleMs) {
					this.log(`Releasing the idle chat session ${key} (${session.acp.sessionId}); its next message resumes it.`, 'debug');
					void this.destroySession(key);
				}
			}
		}
		const warm = this.warm.current;
		if (warm && now - this.warm.usedAt >= WARM_SESSION_IDLE_MS) {
			this.log(`Releasing the session that reads the models (${warm.sessionId}).`, 'debug');
			this.warm.release();
			this.lastAgentUse = now;
			void this.client?.closeSession(warm.sessionId);
		}
	}

	/** Stops the agent process when no chat, release or lookup has needed it for the configured time. */
	private stopIdleAgent(): void {
		const idleMs = agentIdleMs(this.settings);
		if (idleMs <= 0 || !this.client?.isRunning) {
			return;
		}
		if (this.sessions.size > 0 || this.closing.size > 0 || this.warm.current || this.warm.isOpening) {
			return;
		}
		if (Date.now() - this.lastAgentUse < idleMs) {
			return;
		}
		void this.client.stopWhenIdle();
	}

	private async createChatSession(key: string, model: vscode.LanguageModelChatInformation, tools: readonly vscode.LanguageModelChatTool[], context: ChatContext, reuse?: Reuse, effort?: string): Promise<ChatSession> {
		const agent = this.agent;
		const endpoint = await this.deps.bridge.registerSession(tools, (name, input, toolToken) => this.executeTool(key, name, input, toolToken));
		try {
			// A request that offers no tools is Copilot's own, such as a chat title: the
			// agent could not read a customization file without a tool, so the prompt
			// would only be paid for in tokens.
			const systemPromptAppend = tools.length === 0
				? undefined
				: await this.buildSessionPrompt(tools, context.folders, context.guidance);
			const options: CreateSessionOptions = {
				cwd: context.cwd,
				mcpServers: [bridgeServer(endpoint)],
				model: acpModelValue(model.id),
				systemPromptAppend,
				reportEachModelCall: this.reportsEachModelCall,
			};
			const promptHash = promptHashOf(systemPromptAppend);

			let acp: AgentSession | undefined;
			let reused: ChatSession['reused'];
			if (reuse) {
				if (reuse.saved.promptHash !== promptHash) {
					this.log(`[reuse] The session prompt differs from the saved one (${reuse.saved.promptHash} -> ${promptHash}); the first model call will show whether the cache still served it.`);
				}
				try {
					acp = reuse.kind === 'resume'
						? await agent.resumeSession(reuse.saved.sessionId, options)
						: await agent.forkSession(reuse.saved.sessionId, options);
					reused = { how: reuse.kind === 'resume' ? 'resumed' : 'forked', from: reuse.saved.sessionId, logged: false };
					this.log(`[reuse] ${reuse.kind === 'resume' ? 'Resumed' : `Forked ${reuse.saved.sessionId} into`} ACP session ${acp.sessionId}; the first model call will show whether the cache served it.`);
				} catch (error) {
					// The agent no longer has the stored conversation (it expired, or the agent was
					// reinstalled): the chat is rebuilt from Copilot's messages in a new session.
					this.log(`[reuse] Could not ${reuse.kind} saved session ${reuse.saved.sessionId} (${describe(error)}); starting a new session instead.`, 'warn');
					if (reuse.kind === 'resume') {
						this.saved.forget(key);
					}
				}
			}
			acp ??= await agent.createSession(options);

			const history = reused && reuse ? [...reuse.history] : [];
			const toolNames = tools.map(tool => tool.name);
			const session: ChatSession = {
				acp, endpoint, context, history,
				model: model.id,
				toolCount: tools.length,
				openedTools: new Set(toolNames),
				hasPrompt: tools.length > 0,
				failures: 0,
				lastActive: Date.now(),
				toolsHash: toolsHashOf(toolNames),
				guidanceHash: guidanceHashOf(context.guidance),
				promptHash,
				reused,
				guidanceChange: reused ? reuse?.guidanceChange : undefined,
			};
			this.sessions.set(key, session);
			// The agent ignores the model it was asked for when it opens or reopens a
			// session, so the picker's choice is applied here, together with the effort:
			// the effort option only exists once a model has been resolved.
			await applyModel(agent, this.adapter.modelPolicy, session, effort, this.log, reused ? '[reuse] ' : '');
			this.log(`Created chat session for ${key} using ${model.id}`);
			this.log(`Created chat session for ${key} in ${context.cwd}${context.folders ? '' : ' (the window\'s folder; the request named none)'}`, 'debug');
			this.evictIdleSessions(key);
			this.scheduleIdleSweep();
			return session;
		} catch (error) {
			this.deps.bridge.unregisterSession(endpoint.token);
			// An expired login surfaces here on the first request of a chat, exactly as
			// it does on a turn: the user gets the same offer instead of a raw refusal.
			if (this.isSignInRequired(error)) {
				this.promptSignIn();
				throw new vscode.LanguageModelError(this.needsCredentials());
			}
			throw error;
		}
	}

	/** A chat still starts when the customization files cannot be read; it just has no extras. */
	private async buildSessionPrompt(tools: readonly vscode.LanguageModelChatTool[], chatFolders: readonly string[] | undefined, guidance: string | undefined): Promise<string | undefined> {
		try {
			this.sessionPrompt ??= createSessionPrompt(this.log, this.adapter.systemPrompt, this.deps.profilePromptsDir);
			return await this.sessionPrompt(tools, chatFolders, guidance);
		} catch (error) {
			this.log(`Could not build the session prompt: ${describe(error)}`, 'warn');
			return undefined;
		}
	}

	private evictIdleSessions(keep: string): void {
		for (const [key, session] of this.sessions) {
			if (this.sessions.size <= MAX_CHAT_SESSIONS) {
				return;
			}
			if (key !== keep && !session.turn) {
				this.log(`Closing the least recently used chat session ${key}.`, 'debug');
				void this.destroySession(key);
			}
		}
	}

	/** Applies the tool set of a request to the session, which tells the agent when it changed. */
	private applyTools(session: ChatSession, tools: readonly vscode.LanguageModelChatTool[]): void {
		// A request that offers no tools is Copilot's own, such as a chat title: it says
		// nothing about what this chat may use, and emptying the list would only make the
		// agent drop tools it still has.
		if (tools.length === 0) {
			return;
		}
		this.deps.bridge.updateTools(session.endpoint.token, tools);
		session.toolCount = tools.length;
	}


	/**
	 * Hands a tool call the agent made to the caller of the current request.
	 * Resolves with `undefined` when no response is open that could carry the
	 * call, so the bridge runs the tool itself.
	 */
	private executeTool(key: string, name: string, input: unknown, token: vscode.CancellationToken): Promise<McpToolResult | undefined> {
		const turn = this.sessions.get(key)?.turn;
		const callId = `${TOOL_CALL_ID_PREFIX}${this.adapter.id}-${++this.toolCallSeq}`;
		return handOverToolCall(turn, callId, name, input, token, this.log);
	}


	private async switchModel(key: string, session: ChatSession, model: vscode.LanguageModelChatInformation, tools: readonly vscode.LanguageModelChatTool[], context: ChatContext): Promise<ChatSession> {
		if (await switchModelInPlace(this.agent, session, model.id, key, this.log)) {
			return session;
		}
		await this.destroySession(key);
		return this.createChatSession(key, model, tools, context);
	}

	private async destroySession(key: string): Promise<void> {
		const session = this.sessions.get(key);
		if (!session) {
			return;
		}
		this.sessions.delete(key);
		if (session.turn) {
			clearToolDeadline(session.turn);
			disposeCancellations(session.turn);
			failPendingToolCalls(session.turn, new Error("The chat session was closed."));
			this.client?.cancel(session.acp.sessionId);
			session.turn = undefined;
		}
		this.deps.bridge.unregisterSession(session.endpoint.token);
		const closing = this.client?.closeSession(session.acp.sessionId) ?? Promise.resolve();
		this.closing.set(key, closing);
		await closing;
		if (this.closing.get(key) === closing) {
			this.closing.delete(key);
		}
		this.lastAgentUse = Date.now();
		this.log(`Closed the chat session for ${key} (${session.acp.sessionId}).`);
	}

	private handleAgentChange(change: AgentChange): void {
		// The sessions lived in the old process in every case. The next request opens
		// new ones (resuming the stored conversation when it can) and restores the
		// conversation from Copilot's history otherwise.
		const what = change === 'restarted' ? 'was restarted' : change === 'idle' ? 'was stopped for being idle' : 'exited';
		this.log(`The agent ${what}; dropping its sessions.`);
		for (const key of [...this.sessions.keys()]) {
			void this.destroySession(key);
		}
		this.warm.release();

		if (change === 'restarted') {
			// The account may have changed, and with it the models on offer and their windows.
			this.models.reset();
			this.signInWarningShown = false;
			this.changeEmitter.fire();
		}
	}

	private isSignInRequired(error: unknown): boolean {
		return isAuthRequiredError(error) || (this.client?.requiresSignIn ?? false);
	}

	/** What a chat is told when the agent needs credentials, both on a turn and when a session cannot open. */
	private needsCredentials(): string {
		return `${this.adapter.displayName} needs credentials. Open the ACP Hub sidebar to sign in or to use an API key, then try again.`;
	}

	private promptSignIn(): void {
		this.signInEmitter.fire();
		if (this.signInWarningShown) {
			return;
		}
		this.signInWarningShown = true;

		void vscode.window.showWarningMessage(
			`${this.adapter.displayName} needs credentials: sign in or use an API key.`,
			"Sign In",
			"Show Output",
		).then(choice => {
			if (choice === "Sign In") {
				this.deps.signIn(this.adapter.id);
			} else if (choice === "Show Output") {
				this.deps.showOutput();
			}
		});
	}
}
