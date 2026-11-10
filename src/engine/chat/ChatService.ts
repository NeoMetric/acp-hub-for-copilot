/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as path from 'path';
import type { AgentAdapter, AgentSettings, ConversationForker, LaunchContext } from '../../core/adapter';
import { AdapterNotInstalledError, AgentClient, type AgentChange, type AgentClientDeps, type AgentSession, type CreateSessionOptions, type ForkPoint, type SignInUrlPrompt } from '../acp/agentClient';
import { isAuthRequiredError } from '../acp/rpc';
import { withScope } from '../../core/logging';
import { effectiveToolWaitMs, policyOf, type SessionPolicy } from '../../core/sessionPolicy';
import type { ChatRequest, ToolDef, ToolResult } from '../model/chat';
import type { StreamEvent } from '../model/stream';
import { DEFAULT_CHAT_OWNER, type Log, type HostPort } from '../ports/host';
import { buildPromptBlocks } from './assemble';
import type { RequestMeasurement } from './cache';
import { ChatError } from './ChatError';
import { countsOf } from './checkpoints';
import { clearToolDeadline, disposeCancellations, failPendingToolCalls, handOverToolCall, resolveToolResults } from './heldCalls';
import { agentIdleMs, IDLE_SWEEP_MS, idleTimeoutMs, MAX_CHAT_SESSIONS, WARM_SESSION_IDLE_MS } from './idle';
import { describeToolChange, guidanceChangeOf, guidanceDiffers, guidanceHashOf, guidanceLineHashes, mergeGuidanceChange, toolChangeOf, toolsDiffer } from './keys';
import { carriesToolResults, DEFAULT_TRANSCRIPT_OPTIONS, diverged, lastUserMessageIndex, persistentFingerprints, skillContextAfterReply, userWordsAfterReply, type TranscriptOptions } from './messages';
import { acpModelValue, effortFor } from './modelOptions';
import { PromptArchive } from './promptArchive';
import { findEditFork, findReusable, promptHashOf } from './reuse';
import { applyEffort, applyModel, describe, switchModelInPlace } from './sessionOptions';
import { SavedSessionStore, toolsHashOf } from './sessionStore';
import { startLaps, type Lap } from './timing';
import { TurnRunner } from './turns';
import type { AgentApi, ChatContext, ChatSession, FinishedTurn, Reuse, ToolBridge } from './types';
import { bridgeServer, WarmSession } from './warmSession';
import { normalizeRoot, WorkspaceProcesses, workspaceRootOf, type WorkspaceProcess } from './workspaceProcesses';

/** Per-process nonce, so call ids from an earlier run in a chat's history never match a new call. */
const TOOL_CALL_ID_PREFIX = `acp-hub-${randomBytes(4).toString('hex')}-`;

/**
 * How long an agent that is not installed is remembered. The probe looks for the
 * program on disk, so a burst of model-list refreshes must not repeat it, while
 * an agent installed a moment later is found soon after.
 */
const NOT_INSTALLED_TTL_MS = 5_000;

/** Everything the chat use case needs from whoever hosts it. */
export interface ChatServiceDeps {
	/** The agent's own descriptions of what it does. */
	readonly adapter: AgentAdapter;
	/** Everything the service may ask of the host it runs in. */
	readonly host: HostPort;
	/** The MCP tool bridge the host exposes the request's tools through. */
	readonly bridge: ToolBridge;
	/** The launch context of the installed agent, or `undefined` when it is not installed. */
	resolveLaunch(): Promise<LaunchContext | undefined>;
	/** Replaces the real ACP client; tests use it to run the service over a fake. */
	createClient?(adapter: AgentAdapter, ctx: LaunchContext, deps: AgentClientDeps): AgentApi;
	/** What the ACP client needs besides the launch context. */
	readonly client?: { readonly clientVersion?: string; onSignInUrl?(prompt: SignInUrlPrompt | undefined): void };
	/** Turns the request's tools and guidance into the prompt a new session opens with. */
	buildSessionPrompt?(tools: readonly ToolDef[], folders: readonly string[] | undefined, guidance: string | undefined): Promise<string | undefined>;
	/** The transcript settings the host's own configuration holds. */
	transcriptOptions?(): TranscriptOptions;
	/** Records the request for inspection, when the agent's settings ask for it. */
	dumpRequest?(request: ChatRequest, settings: AgentSettings | undefined): void;
	/** Shares a context window the agent reported with whoever lists the models. */
	refineWindow?(model: string, size: number): void;
	/** Fires after a chat turn ended successfully, which spends plan limits. */
	finished?(turn: FinishedTurn): void;
	/** Fires after each model call of a running turn, for agents that report each call. */
	measured?(measurement: RequestMeasurement): void;
	/** Fires when the agent refused a request for lack of credentials, so the account is known to be signed out. */
	signInRequired?(): void;
	/** Fires after the agent process changed, so the host can reset what it knows of it. */
	agentChanged?(change: AgentChange): void;
	/** Whether the host wants the agent running at all. */
	isEnabled?(): boolean;
}

/**
 * The chat use case: one instance per agent, owning the agent process, the
 * chat sessions it serves, their reuse and forks, the tool-call continuation,
 * and the release of what nobody is using. It reaches the outside world only
 * through the host port, so a second host can drive it unchanged.
 */
export class ChatService {

	private readonly sessions = new Map<string, ChatSession>();
	private readonly saved: SavedSessionStore;
	private readonly log: Log;
	/** The agent processes, one per workspace root a chat asked for. */
	private readonly processes: WorkspaceProcesses;
	/** What the agent was last launched with; the settings are read from it. */
	private launch: LaunchContext | undefined;
	private readonly warmSession: WarmSession;
	private readonly turns: TurnRunner;
	private toolCallSeq = 0;
	/** The launch last read, and when it was read; an absent context is kept for {@link NOT_INSTALLED_TTL_MS}. */
	private launchCache: { readonly value: LaunchContext | undefined; readonly at: number } | undefined;
	/** The probe in flight, so a burst of calls shares it. */
	private launchProbe: Promise<LaunchContext | undefined> | undefined;

	/** Sessions being closed, so a request for the same chat waits until the agent has let go of the session. */
	private readonly closing = new Map<string, Promise<void>>();
	private sweepTimer: NodeJS.Timeout | undefined;
	/** Set when the idle shutdown stopped the agent, so the user's return starts it again; see {@link wakeAfterIdle}. */
	private stoppedForIdle = false;
	private closed = false;
	/** Set once the agent is stopped for good, so a turn it was serving ends without an error. */
	private stopping = false;
	/** The model calls counted since the service started, for the per-agent figures. */
	private readonly totals = { calls: 0, inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0 };

	constructor(private readonly deps: ChatServiceDeps) {
		const { adapter, host } = deps;
		const log = withScope(host.log, adapter.id);
		this.log = log;
		this.saved = new SavedSessionStore(host.state, `acpHub.savedSessions.${adapter.id}`);
		this.processes = new WorkspaceProcesses({
			agentId: adapter.id,
			log,
			create: root => this.createClientIn(root),
			changed: (entry, change) => this.handleAgentChange(entry, change),
		});
		this.warmSession = new WarmSession({
			adapter,
			bridge: deps.bridge,
			agentClient: () => this.defaultClient(),
			cwd: () => this.workspaceFolder,
			opened: () => this.scheduleIdleSweep(),
		});
		this.turns = new TurnRunner({
			adapter,
			log,
			saved: this.saved,
			policy: () => this.policy,
			settings: () => this.settings,
			agentOf: session => session.agent,
			refineWindow: (model, size) => this.deps.refineWindow?.(model, size),
			finished: turn => {
				this.deps.finished?.(turn);
				this.scheduleIdleSweep();
			},
			measured: measurement => {
				this.count(measurement);
				this.deps.measured?.(measurement);
			},
			destroySession: key => this.destroySession(key),
			isSignInRequired: error => this.isSignInRequired(error),
			promptSignIn: () => this.promptSignIn(),
			needsCredentials: () => this.needsCredentials(),
			stopping: () => this.stopping,
		});
	}

	get vendor(): string {
		return this.deps.adapter.vendor;
	}

	/** The adapter this service drives, for the host that publishes its models. */
	get adapter(): AgentAdapter {
		return this.deps.adapter;
	}

	/** How many chat sessions the service holds open, for the host that reports its health. */
	get openSessions(): number {
		return this.sessions.size;
	}

	/** The folder the agent was launched in, `''` until it is launched; a chat that names no folder this machine has is rooted there. */
	get workspaceFolder(): string {
		return this.launch?.workspaceFolder ?? '';
	}

	/**
	 * Whether the host wants this agent at all, read from the host's settings every time: a
	 * disabled agent is neither listed nor started, and is offered again as soon as the
	 * setting is turned back on.
	 */
	get enabled(): boolean {
		return this.deps.isEnabled?.() !== false;
	}

	private get settings(): AgentSettings | undefined {
		return this.launch?.settings;
	}

	/**
	 * How long a tool call of this agent may wait for the host's result, from the
	 * adapter's policy; `Infinity` waits for as long as the agent does. A host that
	 * holds calls outside the engine gives them this wait, so a call takes as long
	 * as it does in the sidebar rather than as long as the host likes.
	 */
	get toolWaitMs(): number {
		return effectiveToolWaitMs(this.policy, this.settings ?? {});
	}

	/** The session policy the service asks: the adapter's own, or the native default it inherits. */
	private get policy(): SessionPolicy {
		return policyOf(this.deps.adapter);
	}

	/** Whether the agent reports the usage of each model call, not only of the turn. */
	private get reportsEachModelCall(): boolean {
		return this.deps.adapter.modelCallUsage !== undefined;
	}

	/**
	 * The agent process of a workspace root, started on its first chat. A chat in
	 * another repository gets a process of its own, rooted there; chats of one
	 * repository share one, and the host's own requests run in the window's folder.
	 * An agent that is not installed has no launch context, which says so right
	 * away instead of waiting for a process that will never come.
	 */
	private async processAt(root: string, ctx?: LaunchContext): Promise<WorkspaceProcess> {
		const launch = ctx ?? await this.resolveLaunch();
		const entry = await this.processes.acquire(root === '' ? normalizeRoot(launch.workspaceFolder) : root);
		await entry.client.updateContext(this.launchedFor(entry.root));
		entry.lastUsed = Date.now();
		return entry;
	}

	/** The launch context of the installed agent, or the error that says it is not installed. */
	private async resolveLaunch(): Promise<LaunchContext> {
		const ctx = await this.cachedLaunch();
		if (!ctx) {
			throw new AdapterNotInstalledError(this.deps.adapter.displayName);
		}
		this.launch = ctx;
		return ctx;
	}

	/**
	 * The launch context the host last reported: an installation probe plus the
	 * stored key, so it is read once and not on every model-list refresh. The host
	 * calls {@link invalidateLaunch} when a setting or a secret changes, which is
	 * the only way the launch can change under a running service.
	 */
	private cachedLaunch(): Promise<LaunchContext | undefined> {
		const cached = this.launchCache;
		if (cached && (cached.value !== undefined || Date.now() - cached.at < NOT_INSTALLED_TTL_MS)) {
			return Promise.resolve(cached.value);
		}
		if (!this.launchProbe) {
			this.launchProbe = this.deps.resolveLaunch()
				.then(value => {
					this.launchCache = { value, at: Date.now() };
					return value;
				})
				.finally(() => {
					this.launchProbe = undefined;
				});
		}
		return this.launchProbe;
	}

	/** Forgets the launch the agent was resolved with, so the next ask reads the install and the key again. */
	invalidateLaunch(): void {
		this.launchCache = undefined;
	}

	/** The process the host's own requests run in: the window's first folder. */
	private async defaultProcess(): Promise<WorkspaceProcess> {
		const ctx = await this.resolveLaunch();
		return this.processAt(normalizeRoot(ctx.workspaceFolder), ctx);
	}

	/** The client of the process the host's own requests run in, such as the one that lists the models. */
	private async defaultClient(): Promise<AgentApi> {
		return (await this.defaultProcess()).client;
	}

	/** Opens the client of a new process, rooted in the workspace it will serve. */
	private createClientIn(root: string): AgentApi {
		const launched = this.launchedFor(root);
		const deps: AgentClientDeps = { log: this.log, storageDir: launched.storageDir, clientVersion: this.deps.client?.clientVersion ?? '', onSignInUrl: this.deps.client?.onSignInUrl };
		return this.deps.createClient
			? this.deps.createClient(this.deps.adapter, launched, deps)
			: new AgentClient(this.deps.adapter, launched, deps);
	}

	/** The launch context of one process: the agent's, rooted in the process's workspace. */
	private launchedFor(root: string): LaunchContext {
		const launch = this.launch;
		if (!launch) {
			throw new AdapterNotInstalledError(this.deps.adapter.displayName);
		}
		return { ...launch, workspaceFolder: root };
	}

	/** Runs one request to completion or to a tool call that the host must execute. */
	async respond(request: ChatRequest, sink: (event: StreamEvent) => void, signal: AbortSignal): Promise<void> {
		if (signal.aborted) {
			return;
		}
		// A disabled agent is not started for any entry point; the host's settings decide, so turning it
		// back on needs no restart.
		if (!this.enabled) {
			throw new ChatError(`The ${this.deps.adapter.displayName} agent is disabled; enable it from the ACP Hub sidebar.`);
		}
		const key = request.chatId;
		const lap = startLaps(this.log, key);
		// The launch is resolved first, as it always was: the host reads the window's
		// folder off the launched agent when the request names no folder of its own.
		const launch = await this.resolveLaunch();
		const identity = this.deps.host.chatIdentity(request);
		const entry = await this.processAt(workspaceRootOf(identity), launch);
		const client = entry.client;
		lap('agent client ready');

		const tools = request.tools;
		const context: ChatContext = { folders: identity.workspaceFolders.length > 0 ? identity.workspaceFolders : undefined, cwd: identity.cwd, guidance: this.deps.host.guidanceOf(request) };
		this.deps.dumpRequest?.(request, this.settings);
		const effort = effortFor(request.effort, this.settings);
		const toolNames = tools.map(tool => tool.name);
		this.log(`Request: model ${request.model ?? 'default'}, ${request.messages.length} message(s), ${tools.length} tool(s): ${toolNames.join(', ') || 'none'}`, 'debug');
		// A session released a moment ago must be gone from the agent before it is resumed.
		await this.closing.get(key);
		lap(`previous session settled, ${this.sessions.has(key) ? 'chat has a live session' : 'new chat'}`);
		let session = this.sessions.get(key);
		if (session && session.agent !== client) {
			// The chat came back in another workspace, so its session lives in a process
			// it no longer belongs to: the next request opens one rooted where it is now.
			this.log(`Chat ${key} asks for another workspace; closing the session it held in ${session.context.cwd}.`, 'debug');
			await this.destroySession(key);
			session = undefined;
		}
		if (session) {
			// Re-insert so the map stays ordered by recency of use.
			this.sessions.delete(key);
			this.sessions.set(key, session);
			this.processes.own(session.agent, key);
			session.lastActive = Date.now();
		}

		const modelId = request.model ?? session?.model ?? '';
		if (session && session.model !== modelId) {
			await this.turns.abort(session);
			session = await this.switchModel(key, session, modelId, tools, context);
		}
		const messages = request.messages;
		const fingerprints = persistentFingerprints(messages);
		const lastUser = lastUserMessageIndex(messages);
		const transcriptOptions = this.deps.transcriptOptions?.() ?? DEFAULT_TRANSCRIPT_OPTIONS;

		// The host ran the tools of the pending turn: hand the results back to the
		// agent and keep streaming the same turn into this response. The tools of the
		// session stay as they are until the turn ends, so a result is never dropped.
		// A message the user typed while the turn ran comes next to those results. As
		// natively, it ends the turn and starts a new one, so it falls through below.
		const userWords = session?.turn ? userWordsAfterReply(messages, this.deps.host.stripHostSections) : [];
		const skillContext = session?.turn ? skillContextAfterReply(messages) : undefined;
		if (skillContext && session?.turn && !session.turn.pending.has(skillContext.callId)) {
			this.log(`Skill context could not be matched to a pending tool call for ${key}.`, 'error');
			await this.turns.abort(session);
			throw new ChatError('Skill context could not be matched to its tool call. Please retry your request.');
		}
		const resolved = session?.turn ? resolveToolResults(session.turn, messages, this.log) : false;
		if (session && session.turn && userWords.length === 0 && resolved) {
			this.markSeen(session, fingerprints);
			this.applyTools(session, tools);
			await applyEffort(client, this.deps.adapter.modelPolicy, session, effort, this.log);
			await this.turns.drive(key, session, sink, signal, fingerprints, lastUser);
			return;
		}
		// The result of a call that already ended, such as one that timed out: the agent
		// went on without it, so the running turn is still the one to answer this request.
		if (session && session.turn && !session.turn.finished && userWords.length === 0 && carriesToolResults(messages)) {
			if (session.turn.pending.size > 0 && session.turn.held.length === 0) {
				await this.turns.abort(session);
				throw new ChatError("A tool result could not be matched to the pending call. Please retry your request.");
			}
			this.log(`Late tool results for ${key}; the turn is still running, so this response continues it.`);
			this.markSeen(session, fingerprints);
			this.applyTools(session, tools);
			await applyEffort(client, this.deps.adapter.modelPolicy, session, effort, this.log);
			await this.turns.drive(key, session, sink, signal, fingerprints, lastUser);
			return;
		}
		if (session?.turn) {
			this.log(`The pending turn for ${key} was abandoned; cancelling it.`, 'warn');
			await this.turns.abort(session);
		}

		// An agent that takes a changed tool set in place gets it from `applyTools` below; any other reads
		// its tools only when its session opens.
		const toolsChanged = this.policy.toolsChangedAction() === 'reopen' && session !== undefined && toolsDiffer(session.openedTools, tools);
		if (session && tools.length > 0 && (!session.hasPrompt || toolsChanged)) {
			// The chat was opened by a request that offered no tools, such as a title,
			// and so got no workspace prompt; or the host now offers other tools than the
			// session has. The agent takes its prompt and its tools when it opens a session,
			// so the chat gets a new one that continues the stored conversation when it can,
			// and otherwise has its messages restored.
			const change = session.hasPrompt ? ` (${describeToolChange(toolChangeOf(session.openedTools, toolNames))})` : '';
			this.log(`Chat ${key} ${session.hasPrompt ? `changed its tools${change}` : 'now offers tools'}; reopening it with the current ones.`);
			await this.destroySession(key);
			session = undefined;
		}
		if (!session) {
			const reuse = tools.length > 0 ? findReusable(this.saved, key, fingerprints, lastUser, tools, context, await this.canFork(client), this.log) : undefined;
			session = await this.createChatSession(key, client, identity.owner ?? DEFAULT_CHAT_OWNER, modelId, tools, context, reuse, effort, lap);
			lap('chat session created');
		} else if (tools.length > 0 && guidanceDiffers(session.context.guidance, context.guidance)) {
			this.sendGuidanceChange(key, session, context.guidance);
		}
		this.applyTools(session, tools);
		await applyEffort(client, this.deps.adapter.modelPolicy, session, effort, this.log);
		lap('effort applied');

		// A session that has seen nothing yet only gets the current turn, plus a
		// transcript of what came before: the chat may predate this session (window
		// reload, agent restart), and the agent has no other memory of it.
		let startIndex = session.history.length === 0 ? lastUser : session.history.length;
		let restoreContext = session.history.length === 0;

		if (session.history.length > fingerprints.length || diverged(session.history, fingerprints)) {
			const at = session.history.findIndex((fingerprint, index) => fingerprint !== fingerprints[index]);
			this.log(`Chat history changed for ${key}. The session had seen ${session.history.length} message(s), the request has ${fingerprints.length}; ${at < 0 ? 'the request is shorter and otherwise the same' : `the first difference is message #${at + 1}, shown in full next`}.`, 'warn');
			if (at >= 0) {
				this.log(`[reuse] Message #${at + 1} was: ${session.history[at] ?? ''}`, 'warn');
				this.log(`[reuse] Message #${at + 1} is now: ${fingerprints[at] ?? ''}`, 'warn');
			}
			// The session is left for a fork of the turn the edit still agrees with; with none, or
			// when the fork fails, the chat gets a new session and its messages restored.
			const reuse = tools.length > 0 && await this.canFork(client) ? findEditFork(this.saved, key, fingerprints, lastUser, context, this.log) : undefined;
			this.log(reuse ? `[reuse] Chat ${key} was edited; forking from the checkpoint after ${reuse.checkpoint?.messages} message(s).` : `[reuse] Chat ${key} was edited and has no checkpoint to fork from; starting a fresh ACP session.`, 'debug');
			await this.destroySession(key);
			session = await this.createChatSession(key, client, identity.owner ?? DEFAULT_CHAT_OWNER, modelId, tools, context, reuse, effort);
			this.applyTools(session, tools);
			await applyEffort(client, this.deps.adapter.modelPolicy, session, effort, this.log);
			restoreContext = session.history.length === 0;
			startIndex = restoreContext ? lastUser : session.history.length;
		}

		const blocks = buildPromptBlocks(messages, startIndex, lastUser, restoreContext, session, this.log, transcriptOptions, {
			// The context of the chat is carried only by the prompt that opens a session.
			chatContext: restoreContext ? this.deps.host.chatWideContextOf(messages.slice(0, lastUser)) : undefined,
			stripHostSections: this.deps.host.stripHostSections,
		});
		if (blocks.length === 0) {
			this.log(`The request contained no user text to forward to ${this.deps.adapter.displayName}.`, 'warn');
			throw new ChatError(`There is no user message to send to ${this.deps.adapter.displayName}.`);
		}

		// The agent has been given everything up to here. A turn that never finishes, because
		// the chat was abandoned, is cancelled by the next request, which then looks
		// like the start of the chat and sends the first message again.
		this.markSeen(session, fingerprints);
		session.chat ??= { id: identity.id, label: identity.label ?? 'Chat', workspace: session.context.cwd };
		session.turn = this.turns.start(session, sink, signal, blocks);
		lap('prompt sent to the agent');
		await this.turns.drive(key, session, sink, signal, fingerprints, lastUser);
	}

	/** Records that the agent has been given every message of this request. */
	private markSeen(session: ChatSession, fingerprints: readonly string[]): void {
		session.history.length = 0;
		session.history.push(...fingerprints);
	}

	/** The agent client of the window's folder; the model list asks the agent for its models through it. */
	async client(): Promise<AgentApi> {
		return this.defaultClient();
	}

	/** The warm session, opened or reused: the one that reads the model list. */
	openWarmSession(): Promise<AgentSession> {
		return this.ensureWarmSession();
	}

	/** Notes that the agent answered something of the host's own, for the idle watch. */
	touch(): void {
		const client = this.warmSession.client;
		const entry = client === undefined ? undefined : this.processes.entryOf(client);
		if (entry) {
			this.processes.touch(entry);
		}
		this.scheduleIdleSweep();
	}

	/** Whether the agent refused for lack of credentials. */
	needsSignIn(error: unknown): boolean {
		return this.isSignInRequired(error);
	}

	/** Tells the host's sign-in flow that the agent needs credentials. */
	requestSignIn(): void {
		this.promptSignIn();
	}

	/** Opens the warm session (the one that reads the model list). */
	async warm(): Promise<void> {
		await this.defaultClient();
		await this.ensureWarmSession();
	}

	/** Starts the agent to let its own browser sign-in flow run. */
	async startForSignIn(methodId?: string): Promise<boolean> {
		const agent = await this.defaultClient();
		await agent.restart();
		if (methodId) {
			await agent.signInWithMethod(methodId);
		} else {
			await agent.ensureStarted();
		}
		return !agent.requiresSignIn;
	}

	/** Restarts every agent process; what the host caches about them is reset with it. */
	async restart(): Promise<void> {
		for (const entry of this.processes.list()) {
			await entry.client.restart();
		}
	}

	/**
	 * Starts the agent again, with its warm session, when the idle shutdown stopped it and the user is
	 * back in the window. Starting takes seconds (an agent reaches its servers before it opens a session,
	 * and longer on a slow connection), which the next chat would otherwise wait for. Once per stop.
	 */
	wakeAfterIdle(): void {
		if (!this.stoppedForIdle || this.closed) {
			return;
		}
		this.stoppedForIdle = false;
		if (this.processes.anyRunning() || this.deps.isEnabled?.() === false) {
			return;
		}
		this.log(`The window is in use again; starting the ${this.deps.adapter.displayName} agent it stopped for being idle.`);
		void this.warm().catch(error => this.log(`Could not start the ${this.deps.adapter.displayName} agent again: ${describe(error)}`, 'debug'));
	}

	/**
	 * Sends one prompt to the warm session and returns the reply text, or
	 * `undefined` when the agent is not installed. Usage sources use it for
	 * commands the agent answers itself, which cost no model call.
	 */
	async askAgent(prompt: string): Promise<string | undefined> {
		try {
			await this.warm();
		} catch (error) {
			if (error instanceof AdapterNotInstalledError) {
				return undefined;
			}
			throw error;
		}
		const warm = await this.ensureWarmSession();
		const agent = this.warmSession.client;
		if (!agent) {
			throw new Error('The agent session that reads the model list has no client.');
		}
		let reply = '';
		await agent.prompt(warm.sessionId, [{ type: 'text', text: prompt }], {
			onText: text => {
				reply += text;
			},
		});
		this.warmSession.touch();
		return reply;
	}

	/** Closes every chat session, leaving the agent process for the chats that follow. */
	async closeAllSessions(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map(key => this.destroySession(key)));
	}

	/** Closes every chat session and the agent process. */
	async close(): Promise<void> {
		this.stopAgent();
		// The bridge's streams and heartbeats belong to sessions that are going away;
		// a host that closes leaves none of either behind.
		this.deps.bridge.drain?.();
		await this.closeAllSessions();
	}

	/**
	 * Stops the agent process now, without waiting for the agent to answer: a
	 * stopped agent would never answer the RPC that closes its sessions.
	 */
	private stopAgent(): void {
		this.stopping = true;
		this.warmSession.release();
		this.processes.disposeAll();
	}

	/** Per-agent usage and cache figures, counted since the service started. */
	usage(): unknown {
		const total = this.totals.inputTokens + this.totals.cachedReadTokens + this.totals.cachedWriteTokens;
		return { ...this.totals, hitRate: total > 0 ? (this.totals.cachedReadTokens / total) * 100 : 0 };
	}

	/** Cancels every running turn and closes every chat session, then stops the idle watch. */
	dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		clearTimeout(this.sweepTimer);
		this.stopAgent();
		void this.closeAllSessions().catch(error => this.log(`Could not close the chat sessions: ${describe(error)}`, 'debug'));
	}

	private count(measurement: RequestMeasurement): void {
		this.totals.calls++;
		this.totals.inputTokens += measurement.call.inputTokens;
		this.totals.cachedReadTokens += measurement.call.cachedReadTokens;
		this.totals.cachedWriteTokens += measurement.call.cachedWriteTokens;
		this.totals.outputTokens += measurement.call.outputTokens;
	}

	private ensureWarmSession(): Promise<AgentSession> {
		const client = this.warmSession.client;
		const entry = client === undefined ? undefined : this.processes.entryOf(client);
		if (entry) {
			this.processes.touch(entry);
		}
		return this.warmSession.ensure();
	}

	/** Arms the sweep for idle sessions; it re-arms itself for as long as a session is left to watch. */
	private scheduleIdleSweep(): void {
		if (this.closed || this.sweepTimer) {
			return;
		}
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = undefined;
			this.releaseIdleSessions();
			this.stopIdleAgent();
			if (this.sessions.size > 0 || this.warmSession.current || (this.processes.anyRunning() && agentIdleMs(this.settings) > 0)) {
				this.scheduleIdleSweep();
			}
		}, IDLE_SWEEP_MS);
		this.sweepTimer.unref();
	}

	/**
	 * Gives back the sessions nobody is using. A session with a turn is never
	 * released, including one waiting for the host to run a tool. A released chat
	 * is picked up again from its stored conversation on its next request.
	 */
	private releaseIdleSessions(): void {
		const now = Date.now();
		const idleMs = idleTimeoutMs(this.settings);
		if (idleMs > 0) {
			for (const [key, session] of [...this.sessions]) {
				if (!session.turn && session.agent.hasBackgroundTasks(session.acp.sessionId)) {
					session.lastActive = now;
					continue;
				}
				if (!session.turn && now - session.lastActive >= idleMs) {
					this.log(`Releasing the idle chat session ${key} (${session.acp.sessionId}); its next message resumes it.`, 'debug');
					void this.destroySession(key);
				}
			}
		}
		const warm = this.warmSession.current;
		if (warm && now - this.warmSession.usedAt >= WARM_SESSION_IDLE_MS) {
			this.log(`Releasing the session that reads the models (${warm.sessionId}).`, 'debug');
			const client = this.warmSession.client;
			this.warmSession.release();
			void client?.closeSession(warm.sessionId);
		}
	}

	/** Stops a process when no chat, release or lookup has needed it for the configured time. */
	private stopIdleAgent(): void {
		const idleMs = agentIdleMs(this.settings);
		if (idleMs <= 0) {
			return;
		}
		for (const entry of this.processes.list()) {
			if (!entry.client.isRunning) {
				continue;
			}
			if (entry.sessions.size > 0 || this.closing.size > 0) {
				continue;
			}
			if (this.warmSession.current && this.warmSession.client === entry.client) {
				continue;
			}
			if (Date.now() - entry.lastUsed < idleMs) {
				continue;
			}
			void entry.client.stopWhenIdle();
		}
	}

	private async createChatSession(key: string, agent: AgentApi, owner: string, modelId: string, tools: readonly ToolDef[], context: ChatContext, reuse?: Reuse, effort?: string, lap?: Lap): Promise<ChatSession> {
		const endpoint = await this.deps.bridge.registerSession(tools, (name, input, signal) => this.executeTool(key, name, input, signal), { maxResultChars: this.deps.adapter.maxToolResultChars });
		lap?.(`tool bridge registered (${tools.length} tool(s))`);
		try {
			// A request that offers no tools is the host's own, such as a chat title: the
			// agent could not read a customization file without a tool, so the prompt
			// would only be paid for in tokens.
			let systemPromptAppend = tools.length === 0
				? undefined
				: await this.buildSessionPrompt(tools, context.folders, context.guidance);
			lap?.(`session prompt built (${systemPromptAppend?.length ?? 0} character(s))`);
			// The prompt leads the conversation, so a reworded one misses the cache for all of it. A policy
			// that opens a stored conversation with the prompt it began with is sent that one; what changed
			// in the guidance is sent as a message.
			const policy = this.policy;
			if (policy.keepsSavedPrompt) {
				const savedHash = reuse?.saved.promptHash;
				const savedPrompt = savedHash && systemPromptAppend && savedHash !== promptHashOf(systemPromptAppend)
					? await this.promptArchive().recall(savedHash)
					: undefined;
				const chosen = policy.promptForOpen({ savedPrompt, rebuilt: systemPromptAppend });
				if (savedPrompt !== undefined && chosen === savedPrompt) {
					this.log(`[reuse] Sending the session prompt the saved session began with (${savedHash}) instead of the rebuilt one (${promptHashOf(systemPromptAppend)}), so the cache can serve the conversation.`, 'debug');
				}
				systemPromptAppend = chosen;
				void this.promptArchive().remember(systemPromptAppend);
			}
			const options: CreateSessionOptions = {
				cwd: context.cwd,
				mcpServers: [bridgeServer(endpoint)],
				model: acpModelValue(modelId),
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
					const point = reuse.checkpoint && { messageId: reuse.checkpoint.messageId, messageFingerprint: reuse.checkpoint.fingerprint, messageOccurrence: reuse.checkpoint.occurrence };
					// A fork that cannot be made (the source is mid-turn, or the tool that forks is missing) leaves `opened` empty: the chat gets a new session.
					const opened = reuse.kind === 'resume'
						? await agent.resumeSession(reuse.saved.sessionId, options)
						: await this.fork(reuse, agent, options, point, reuse.saved.key === key);
					if (opened) {
						acp = opened;
						reused = { how: reuse.kind === 'resume' ? 'resumed' : 'forked', from: reuse.saved.sessionId, logged: false };
						this.log(`[reuse] ${reuse.kind === 'resume' ? 'Resumed' : `Forked ${reuse.saved.sessionId}${point ? ` after ${reuse.checkpoint?.messages} message(s)` : ''} into`} ACP session ${acp.sessionId}; the first model call will show whether the cache served it.`);
					} else {
						this.log(`[reuse] No fork of saved session ${reuse.saved.sessionId} was made; starting a new session and restoring the chat as a transcript.`, 'debug');
					}
				} catch (error) {
					// The agent no longer has the stored conversation (it expired, or the agent was
					// reinstalled): the chat is rebuilt from the host's messages in a new session.
					this.log(`[reuse] Could not ${reuse.kind} saved session ${reuse.saved.sessionId} (${describe(error)}); starting a new session instead.`, 'warn');
					if (reuse.kind === 'resume') {
						this.saved.forget(key);
					}
				}
			}
			acp ??= await agent.createSession(options);
			lap?.('agent session opened');

			const history = reused && reuse ? [...reuse.history] : [];
			// A fork holds the turns up to its fork point only, so it keeps the checkpoints of those.
			const inherited = !reused || !reuse ? [] : reuse.kind === 'resume' ? reuse.saved.checkpoints ?? [] : (reuse.saved.checkpoints ?? []).filter(checkpoint => checkpoint.messages <= (reuse.checkpoint?.messages ?? 0));
			const toolNames = tools.map(tool => tool.name);
			const session: ChatSession = {
				agent, owner, acp, endpoint, context, history,
				checkpoints: [...inherited],
				messageCounts: countsOf(inherited),
				forked: reused?.how === 'forked' && !this.deps.adapter.forker ? true : reused && reuse ? reuse.saved.forked : undefined,
				model: modelId,
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
			this.processes.own(agent, key);
			// The agent ignores the model it was asked for when it opens or reopens a
			// session, so the picker's choice is applied here, together with the effort:
			// the effort option only exists once a model has been resolved.
			await applyModel(agent, this.deps.adapter.modelPolicy, session, effort, this.log, reused ? '[reuse] ' : '');
			lap?.('model applied');
			this.log(`Created chat session for ${key} using ${modelId}`);
			this.log(`Created chat session for ${key} in ${context.cwd}${context.folders ? '' : ' (the window\'s folder; the request named none)'}`, 'debug');
			this.evictIdleSessions(key);
			this.scheduleIdleSweep();
			void this.deleteOrphanedForks(agent).catch(error => this.log(`Could not delete expired forked sessions: ${describe(error)}`, 'debug'));
			return session;
		} catch (error) {
			this.deps.bridge.unregisterSession(endpoint.token);
			// An expired login surfaces here on the first request of a chat, exactly as
			// it does on a turn: the user gets the same offer instead of a raw refusal.
			if (this.isSignInRequired(error)) {
				this.promptSignIn();
				throw new ChatError(this.needsCredentials());
			}
			throw error;
		}
	}

	/**
	 * Continues the stored conversation as the policy says: by resuming it, by copying it with the agent's own
	 * fork or the adapter's forker, or not at all. Returns `undefined` when it cannot be continued now: the
	 * policy says to start over, or the program that forks for this agent is missing.
	 * Whatever fails throws, and the caller falls back to a new session.
	 */
	private async fork(reuse: Reuse, agent: AgentApi, options: CreateSessionOptions, point: ForkPoint | undefined, editedOwnChat: boolean): Promise<AgentSession | undefined> {
		const source = reuse.saved.sessionId;
		const running = [...this.sessions.values()].find(session => session.acp.sessionId === source && session.turn);
		if (running) {
			// A chat the user stopped, or left, to branch off may still be winding down. The fork point is a
			// finished turn, so what the turn in flight said is no part of the copy; it is cancelled and settled first.
			this.log(`[reuse] Saved session ${source} is in the middle of a turn; cancelling it before the fork.`, 'warn');
			await this.turns.abort(running);
		}
		const forker = this.deps.adapter.forker;
		// Without a fork point there is no step to cut at, and a declined notice is not asked again.
		if (forker && (!point || this.forkNoticeState() === 'declined')) {
			return undefined;
		}
		// The program is found before the policy is asked, so the chats it weighs are read afterwards, as the
		// pre-policy code read them: a chat that starts a turn meanwhile must be counted, or a restart for the
		// fork would end its turn.
		const program = forker ? await forker.locate(this.settings ?? {}, this.log, this.launch?.entryPath) : undefined;
		if (forker && !program) {
			this.noteMissingForker(forker);
			return undefined;
		}
		const live = [...this.sessions].map(([chatKey, session]) => ({ chatKey, sessionId: session.acp.sessionId, hasTurn: session.turn !== undefined }));
		const plan = this.policy.planContinuation({ saved: reuse.saved, live, editedOwnChat, agentSupportsFork: agent.supportsFork, externalForker: forker });
		if (plan.how === 'rebuild') {
			return undefined;
		}
		if (plan.how === 'resume') {
			return agent.resumeSession(source, options);
		}
		if (plan.how === 'fork-native') {
			return agent.forkSession(source, options, point);
		}
		if (!forker || !program || !point) {
			return undefined;
		}
		if (editedOwnChat && !plan.keepSourceId) {
			const busy = live.filter(session => session.hasTurn && session.sessionId !== source).map(session => session.chatKey);
			if (busy.length > 0) {
				this.log(`[reuse] The fork takes a new session id, which misses the cache once, because ${busy.length} other chat(s) are in the middle of a turn: ${busy.join(', ')}.`, 'warn');
			}
		}
		// An edited chat leaves its old session, and a rewind needs it let go of. A copy leaves the source open, so its
		// chat goes on in the live session: closing and resuming a conversation makes the agent send all of it uncached.
		if (editedOwnChat) {
			for (const [key, session] of [...this.sessions]) {
				if (session.acp.sessionId === source) {
					await this.destroySession(key);
				}
			}
		}
		// The restart runs beside the fork, which uses a language server of its own, and is waited on
		// before the copy is opened. Should it fail, the rewound conversation is not read again, so the
		// chat is rebuilt from its transcript rather than continued on the wrong one.
		const restarting = plan.restartFirst
			? agent.restart().then(() => {
				// Starting it again takes a few seconds; do that while the fork runs, and let the resume
				// report a start that fails.
				void agent.ensureStarted().catch(() => undefined);
				return true;
			}, error => {
				this.log(`[reuse] Could not restart the agent for the fork (${describe(error)}); the chat is rebuilt from its transcript.`, 'warn');
				return false;
			})
			: undefined;
		const forked = await forker.fork(program, { sessionId: source, point, cwd: options.cwd, keepSourceId: plan.keepSourceId }, this.log);
		if (forked.sourceMovedTo) {
			if (restarting && !await restarting) {
				return undefined;
			}
			this.saved.moveSession(source, forked.sourceMovedTo);
			this.log(`[reuse] The fork goes on in ${source}; the chats that had it continue in the copy ${forked.sourceMovedTo}.`, 'debug');
		}
		return agent.resumeSession(forked.sessionId, options);
	}

	private prompts: PromptArchive | undefined;

	private promptArchive(): PromptArchive {
		if (!this.prompts) {
			const dir = this.launch?.storageDir;
			this.prompts = new PromptArchive(dir ? path.join(dir, 'prompts') : undefined);
			void this.prompts.prune();
		}
		return this.prompts;
	}

	private forkNoticeState(): string | undefined {
		return this.deps.host.state.get<string>(`acpHub.forkNotice.${this.deps.adapter.id}`);
	}

	/**
	 * Tells the user once that forking needs a program that is not installed, with a way to get it.
	 * A user who declines is not asked again, and the chat falls back to a transcript either way.
	 */
	private noteMissingForker(forker: ConversationForker): void {
		if (this.forkNoticeState() !== undefined) {
			return;
		}
		void this.deps.host.state.update(`acpHub.forkNotice.${this.deps.adapter.id}`, 'shown');
		const { message, helpLabel, helpUrl, declineLabel } = forker.missing;
		void this.deps.host.ui.notify(message, [helpLabel, declineLabel]).then(choice => {
			if (choice === helpLabel) {
				void this.deps.host.ui.openExternal(helpUrl);
			} else if (choice === declineLabel) {
				void this.deps.host.state.update(`acpHub.forkNotice.${this.deps.adapter.id}`, 'declined');
			}
		});
	}

	/** Deletes the sessions the extension forked whose saved entry expired, for an agent that can; each is tried once. */
	private async deleteOrphanedForks(agent: AgentApi): Promise<void> {
		const pending = this.saved.pendingDeletions();
		if (pending.length === 0 || !agent.supportsDelete) {
			return;
		}
		const inUse = new Set([...this.sessions.values()].map(session => session.acp.sessionId));
		const saved = new Set(this.saved.all().map(entry => entry.sessionId));
		const attempted = pending.filter(id => !inUse.has(id));
		for (const id of attempted.filter(id => !saved.has(id))) {
			if (await agent.deleteSession(id)) {
				this.log(`Deleted the expired forked session ${id}.`, 'debug');
			}
		}
		this.saved.settleDeletions(attempted);
	}

	/**
	 * Whether a chat may continue from a stored conversation by forking: the adapter's policy says so,
	 * which may turn on what the running agent said in `initialize`. Starts the agent to find out.
	 */
	private async canFork(agent: AgentApi): Promise<boolean> {
		if (this.deps.adapter.forker) {
			return true;
		}
		try {
			await agent.ensureStarted();
		} catch {
			// Opening the session starts the agent again and reports why it cannot.
			return false;
		}
		if (!this.policy.canFork({ agentSupportsFork: agent.supportsFork })) {
			this.log(`[reuse] ${this.deps.adapter.displayName} did not advertise session forking; chats are not forked.`, 'debug');
			return false;
		}
		return true;
	}

	/** A chat still starts when the customization files cannot be read; it just has no extras. */
	private async buildSessionPrompt(tools: readonly ToolDef[], chatFolders: readonly string[] | undefined, guidance: string | undefined): Promise<string | undefined> {
		try {
			return await this.deps.buildSessionPrompt?.(tools, chatFolders, guidance);
		} catch (error) {
			this.log(`Could not build the session prompt: ${describe(error)}`, 'warn');
			return undefined;
		}
	}

	private evictIdleSessions(keep: string): void {
		// The cap is per owner, so one client's burst of chats cannot close another's.
		const counts = new Map<string, number>();
		for (const session of this.sessions.values()) {
			counts.set(session.owner, (counts.get(session.owner) ?? 0) + 1);
		}
		for (const [key, session] of this.sessions) {
			const count = counts.get(session.owner) ?? 0;
			if (count <= MAX_CHAT_SESSIONS || key === keep || session.turn) {
				continue;
			}
			counts.set(session.owner, count - 1);
			this.log(`Closing the least recently used chat session ${key} of ${session.owner}.`, 'debug');
			void this.destroySession(key);
		}
	}

	/**
	 * The host describes the chat afresh with every request, and the agent keeps the
	 * guidance it was opened with. As natively, a live session is not reopened for that:
	 * the lines that changed go with the next prompt, and the session counts from then on
	 * as having been told the new guidance.
	 */
	private sendGuidanceChange(key: string, session: ChatSession, guidance: string | undefined): void {
		const change = guidanceChangeOf(guidanceLineHashes(session.context.guidance), guidance, session.context.guidance ?? '');
		const pending = session.guidanceChange;
		if (change.added.length > 0 || change.removed > 0) {
			session.guidanceChange = pending ? mergeGuidanceChange(pending, change) : change;
		}
		const hash = guidanceHashOf(guidance);
		this.log(`The guidance of chat ${key} changed (${session.guidanceHash} -> ${hash}): ${change.added.length} line(s) new, ${change.removed} gone; sending the change with the next prompt.`, 'debug');
		session.context = { ...session.context, guidance };
		session.guidanceHash = hash;
	}

	/** Applies the tool set of a request to the session, which tells the agent when it changed. */
	private applyTools(session: ChatSession, tools: readonly ToolDef[]): void {
		// A request that offers no tools is the host's own, such as a chat title: it says
		// nothing about what this chat may use, and emptying the list would only make the
		// agent drop tools it still has.
		if (tools.length === 0) {
			return;
		}
		this.deps.bridge.updateTools(session.endpoint.token, tools);
		session.toolCount = tools.length;
		// Only an agent that takes the list again has the new tools now; any other keeps
		// what it opened with, so the next request still sees the difference.
		if (this.policy.toolsChangedAction() === 'list-changed' && toolsDiffer(session.openedTools, tools)) {
			const names = tools.map(tool => tool.name);
			this.log(`Tools of the chat session changed: ${describeToolChange(toolChangeOf(session.openedTools, names))}.`, 'debug');
			session.openedTools = new Set(names);
			session.toolsHash = toolsHashOf(names);
		}
	}

	/**
	 * Hands a tool call the agent made to the caller of the current request.
	 * Resolves with `undefined` when no response is open that could carry the
	 * call, so the bridge runs the tool itself.
	 */
	private executeTool(key: string, name: string, input: unknown, signal: AbortSignal): Promise<ToolResult | undefined> {
		const turn = this.sessions.get(key)?.turn;
		const callId = `${TOOL_CALL_ID_PREFIX}${this.deps.adapter.id}-${++this.toolCallSeq}`;
		return handOverToolCall(turn, callId, name, input, signal, this.log);
	}

	private async switchModel(key: string, session: ChatSession, modelId: string, tools: readonly ToolDef[], context: ChatContext): Promise<ChatSession> {
		if (await switchModelInPlace(session.agent, session, modelId, key, this.log)) {
			return session;
		}
		await this.destroySession(key);
		return this.createChatSession(key, session.agent, session.owner, modelId, tools, context);
	}

	private async destroySession(key: string): Promise<void> {
		const session = this.sessions.get(key);
		if (!session) {
			return;
		}
		this.sessions.delete(key);
		this.processes.release(key);
		if (session.turn) {
			clearToolDeadline(session.turn);
			disposeCancellations(session.turn);
			failPendingToolCalls(session.turn, new Error("The chat session was closed."));
			session.agent.cancel(session.acp.sessionId);
			session.turn = undefined;
		}
		this.deps.bridge.unregisterSession(session.endpoint.token);
		const closing = session.agent.closeSession(session.acp.sessionId);
		this.closing.set(key, closing);
		await closing;
		if (this.closing.get(key) === closing) {
			this.closing.delete(key);
		}
		this.log(`Closed the chat session for ${key} (${session.acp.sessionId}).`);
	}

	private handleAgentChange(entry: WorkspaceProcess, change: AgentChange): void {
		// The sessions lived in the old process in every case. The next request opens
		// new ones (resuming the stored conversation when it can) and restores the
		// conversation from the host's history otherwise.
		const what = change === 'restarted' ? 'was restarted' : change === 'idle' ? 'was stopped for being idle' : 'exited';
		this.log(`The agent in ${entry.root} ${what}; dropping its sessions.`);
		this.stoppedForIdle = change === 'idle';
		for (const key of [...entry.sessions]) {
			void this.destroySession(key);
		}
		if (this.warmSession.client === entry.client) {
			this.warmSession.release();
		}
		this.deps.agentChanged?.(change);
	}

	private isSignInRequired(error: unknown): boolean {
		return isAuthRequiredError(error) || this.processes.anySignInRequired();
	}

	/** What a chat is told when the agent needs credentials, both on a turn and when a session cannot open. */
	private needsCredentials(): string {
		return `${this.deps.adapter.displayName} needs credentials. Open the ACP Hub sidebar to sign in or to use an API key, then try again.`;
	}

	private promptSignIn(): void {
		this.deps.signInRequired?.();
	}
}
