/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentAdapter, AgentSettings, LaunchContext } from './adapter';
import type { AcpContentBlock } from './convert';
import { hideConsoleNodeOptions } from './hideConsole';
import { levelOfLine, type Log, type LogLevel } from './logging';
import { forgetAgent, killOrphanedServers, killStrayAgents, killTree, killTreeSync, pipeLines, recordAgent, trackChild, untrackChild } from './processes';
import { isAuthRequiredError, JsonRpcConnection, RpcConnectionClosedError, RpcError } from './rpc';

const ACP_PROTOCOL_VERSION = 1;
const INVALID_PARAMS_CODE = -32602;

/** Time limits for the short requests; `session/prompt` has none, as a turn can run for long. */
const INITIALIZE_TIMEOUT_MS = 120_000;
const NEW_SESSION_TIMEOUT_MS = 60_000;
const SET_CONFIG_TIMEOUT_MS = 30_000;
const CLOSE_SESSION_TIMEOUT_MS = 10_000;
const AUTHENTICATE_TIMEOUT_MS = 5 * 60_000;

/** How long a permission prompt waits for the user before the tool is declined. */
const PERMISSION_TIMEOUT_MS = 5 * 60_000;

/** An agent that exits sooner than this after it started counts as failing to start. */
const FAST_EXIT_MS = 10_000;
/** After this many failed starts in a row the agent is not started again until the cool-down passes or a manual restart. */
const MAX_FAST_EXITS = 3;
const FAST_EXIT_COOLDOWN_MS = 2 * 60_000;

/** Arguments of a program started through the shell may only use these characters. */
const SHELL_SAFE_ARGUMENT = /^[\w@+=:,./\\-]+$/;

export interface AcpMcpHttpServer {
	readonly type: 'http';
	readonly name: string;
	readonly url: string;
	readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface AcpConfigOptionChoice {
	readonly value: string;
	readonly name: string;
	readonly description?: string | null;
}

export interface AcpConfigOptionGroup {
	readonly group: string;
	readonly options: ReadonlyArray<AcpConfigOptionChoice>;
}

export interface AcpConfigOption {
	readonly id: string;
	readonly name: string;
	readonly description?: string | null;
	readonly category?: string | null;
	readonly type: string;
	readonly currentValue?: string | boolean;
	readonly options?: ReadonlyArray<AcpConfigOptionChoice | AcpConfigOptionGroup>;
}

/** The loosely typed content block carried by an agent -> client `session/update`. */
export interface AcpUpdateContent {
	readonly type: string;
	readonly text?: string;
	/** Base64 payload of an image block. */
	readonly data?: string;
	readonly mimeType?: string;
	readonly uri?: string | null;
}

export interface AcpSessionUpdate {
	readonly sessionUpdate: string;
	readonly asyncTaskId?: string;
	readonly state?: string;
	readonly content?: AcpUpdateContent | null;
	readonly toolCallId?: string;
	readonly title?: string;
	readonly used?: number;
	readonly size?: number;
	readonly entries?: ReadonlyArray<{ readonly content: string; readonly status: string; readonly priority: string }>;
}

/** One entry of ACP's own model catalogue, whose ids may carry the effort as `model[effort]`. */
export interface AcpModelInfo {
	readonly modelId?: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AcpModels {
	readonly availableModels?: readonly AcpModelInfo[];
	readonly currentModelId?: string;
}

/** A sign-in method the agent advertised in `initialize`. */
export interface AcpAuthMethod {
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AgentSession {
	readonly sessionId: string;
	configOptions: readonly AcpConfigOption[];
	/** The model catalogue the agent reported with this session, if it did. */
	readonly models?: AcpModels;
}

export interface CreateSessionOptions {
	readonly cwd: string;
	readonly mcpServers: readonly AcpMcpHttpServer[];
	readonly model?: string;
	/** Text added to the end of the agent's own system prompt, which stays in place. */
	readonly systemPromptAppend?: string;
	/** Whether the usage of each model call is reported as it happens, not only when the turn ends. */
	readonly reportEachModelCall?: boolean;
}

export interface PromptHandlers {
	readonly onText: (text: string) => void;
	readonly onThought?: (text: string) => void;
	readonly onUpdate?: (update: AcpSessionUpdate) => void;
	/** The usage of one model call of the turn, as soon as that call finishes. */
	readonly onUsage?: (usage: AcpTokenUsage) => void;
	readonly token?: vscode.CancellationToken;
}

/** Token counts of one turn, as reported by the agent. */
export interface AcpTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedReadTokens: number;
	readonly cachedWriteTokens: number;
	readonly totalTokens: number;
	readonly reasoningOutputTokens?: number;
}

export interface PromptResult {
	readonly stopReason: string;
	readonly usage?: AcpTokenUsage;
}

/**
 * Why {@link AgentClient.onDidChange} fired: `restarted` after a deliberate
 * restart (the account may have changed), `exited` after the process died on
 * its own, `idle` after it was stopped for being unused. After any of them the
 * agent's sessions are gone.
 */
export type AgentChange = 'restarted' | 'exited' | 'idle';

/** What the client needs from its host. */
export interface AgentClientDeps {
	log: Log;
	/** Folder for the record of running agents and the console-hiding helper. */
	storageDir: string;
	clientVersion: string;
	/** Shows a permission prompt and resolves with the index of the chosen label, or `undefined` when dismissed. */
	askPermission?(message: string, labels: string[]): Promise<number | undefined>;
}

/** Thrown when the agent has not been installed, so there is nothing to start. */
export class AdapterNotInstalledError extends Error {

	constructor(displayName: string) {
		super(`The ${displayName} agent is not installed yet. Install the agent from the ACP Hub sidebar.`);
		this.name = 'AdapterNotInstalledError';
	}
}

/** A start that was overtaken by a stop or restart; callers start again instead of failing. */
class StartSupersededError extends Error {

	constructor() {
		super('The agent was stopped while it was starting.');
		this.name = 'StartSupersededError';
	}
}

interface AcpInitializeResponse {
	readonly protocolVersion?: number;
	readonly authMethods?: readonly AcpAuthMethod[];
	readonly agentInfo?: { readonly name?: string; readonly title?: string; readonly version?: string };
	readonly agentCapabilities?: Record<string, unknown>;
}

interface AcpNewSessionResponse {
	readonly sessionId: string;
	readonly configOptions?: ReadonlyArray<AcpConfigOption>;
	readonly models?: AcpModels;
}

/** The adapter's own per-turn breakdown, which names the cache counts differently from `usage`. */
interface AcpQuotaTokenCount extends Partial<AcpTokenUsage> {
	readonly cachedInputTokens?: number;
	readonly cacheWriteInputTokens?: number;
}

interface AcpPromptResponse {
	readonly stopReason?: string;
	readonly usage?: Partial<AcpTokenUsage>;
	readonly _meta?: { readonly quota?: { readonly token_count?: AcpQuotaTokenCount | null } };
}

interface PermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind: string;
}

interface RequestPermissionParams {
	readonly sessionId?: string;
	readonly toolCall?: {
		readonly toolCallId?: string;
		readonly title?: string;
		readonly kind?: string;
	} | null;
	readonly options?: ReadonlyArray<PermissionOption>;
}

/**
 * Owns one agent process: starts it the way the adapter says, speaks ACP over
 * its stdio, restarts it after a crash on the next request, stops it when it
 * has been idle, and exposes the operations the language model provider needs.
 * It never looks at which agent it is; the adapter holds every difference.
 */
export class AgentClient implements vscode.Disposable {

	private readonly changeEmitter = new vscode.EventEmitter<AgentChange>();
	/** Fires after the process was restarted, exited on its own, or was stopped for being idle. */
	readonly onDidChange = this.changeEmitter.event;

	private child: cp.ChildProcess | undefined;
	private rpc: JsonRpcConnection | undefined;
	private startedAt = 0;
	private starting: Promise<JsonRpcConnection> | undefined;
	/** Bumped whenever the process is stopped, so a start that was overtaken can notice. */
	private generation = 0;
	private fastExits = 0;
	private lastFailureAt = 0;
	private disposed = false;

	private busyOperations = 0;
	private idleTimer: NodeJS.Timeout | undefined;

	private readonly turnSinks = new Map<string, (update: AcpSessionUpdate) => void>();
	private readonly usageSinks = new Map<string, (usage: AcpTokenUsage) => void>();
	private readonly seenCalls = new Set<string>();
	private readonly backgroundTasks = new Map<string, Set<string>>();
	/** Resolvers of the permission prompts that are open, by ACP session. */
	private readonly openPermissions = new Map<string, Set<() => void>>();
	private authMethods: readonly AcpAuthMethod[] = [];
	private authStatus: unknown;
	private signInRequired = false;

	constructor(
		private readonly adapter: AgentAdapter,
		private ctx: LaunchContext,
		private readonly deps: AgentClientDeps,
	) { }

	/** Whether the agent reported that it authenticates with an API key. */
	get usesApiKey(): boolean {
		return (this.authStatus as { kind?: unknown } | undefined)?.kind === 'api_key';
	}

	/** The last `_auth/status_update` payload reported by the agent, if any. */
	get lastAuthStatus(): unknown {
		return this.authStatus;
	}

	/** Whether the agent refused a request with "authentication required". */
	get requiresSignIn(): boolean {
		return this.signInRequired;
	}

	/** Sign-in methods advertised by the agent during `initialize`. */
	get availableAuthMethods(): readonly AcpAuthMethod[] {
		return this.authMethods;
	}

	/** Whether an agent process is running or on its way up. */
	get isRunning(): boolean {
		return this.rpc !== undefined || this.starting !== undefined;
	}

	/**
	 * Hands the client a new launch context (a changed API key, a changed
	 * setting). A running agent was started with the old one, so it is restarted.
	 */
	async updateContext(ctx: LaunchContext): Promise<void> {
		const changed = JSON.stringify(ctx) !== JSON.stringify(this.ctx);
		this.ctx = ctx;
		if (changed && this.isRunning) {
			this.log('The launch settings changed; restarting the agent to apply them.');
			await this.restart();
		}
	}

	/** Starts the agent if needed and returns the live connection. */
	async ensureStarted(): Promise<JsonRpcConnection> {
		// A restart (a changed API key, a sign-in) can overtake a start in flight; the start
		// then begins again against the new state instead of failing the caller.
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.startOnce();
			} catch (error) {
				if (!(error instanceof StartSupersededError) || attempt >= 2 || this.disposed) {
					throw error;
				}
			}
		}
	}

	private async startOnce(): Promise<JsonRpcConnection> {
		if (this.disposed) {
			throw new Error(`The ${this.adapter.displayName} agent has been disposed.`);
		}
		if (this.starting) {
			return this.starting;
		}
		if (this.rpc) {
			return this.rpc;
		}
		if (this.fastExits >= MAX_FAST_EXITS && Date.now() - this.lastFailureAt > FAST_EXIT_COOLDOWN_MS) {
			this.log('The cool-down after repeated start failures has passed; trying to start the agent again.');
			this.fastExits = 0;
		}
		if (this.fastExits >= MAX_FAST_EXITS) {
			throw new Error(`The ${this.adapter.displayName} agent keeps stopping right after it starts. Check the ACP Hub output channel, then restart the agent from the ACP Hub sidebar.`);
		}

		const starting = this.start();
		this.starting = starting;
		const clear = () => {
			if (this.starting === starting) {
				this.starting = undefined;
			}
		};
		starting.then(clear, clear);
		return starting;
	}

	async createSession(options: CreateSessionOptions): Promise<AgentSession> {
		return this.openSession('session/new', undefined, options);
	}

	/**
	 * Opens the agent's stored conversation `sessionId` again, as it was: the
	 * agent rebuilds the exact messages from its transcript, so the prompt cache
	 * can serve them. The session keeps its id.
	 */
	async resumeSession(sessionId: string, options: CreateSessionOptions): Promise<AgentSession> {
		return this.openSession('session/resume', sessionId, options);
	}

	/** Copies the stored conversation `sessionId`, up to its latest message, into a session of its own. */
	async forkSession(sessionId: string, options: CreateSessionOptions): Promise<AgentSession> {
		return this.openSession('session/fork', sessionId, options);
	}

	private async openSession(method: 'session/new' | 'session/resume' | 'session/fork', sourceId: string | undefined, options: CreateSessionOptions): Promise<AgentSession> {
		this.beginOperation();
		try {
			const rpc = await this.ensureStarted();
			const extra = this.sessionExtras(options, method === 'session/new');
			const params = { ...(sourceId ? { sessionId: sourceId } : {}), cwd: options.cwd, mcpServers: options.mcpServers, ...extra };

			let response: Partial<AcpNewSessionResponse> | undefined;
			try {
				response = await rpc.request<Partial<AcpNewSessionResponse>>(method, params, { timeoutMs: NEW_SESSION_TIMEOUT_MS });
			} catch (error) {
				this.captureAuthState(error);
				// Without the options the agent would run with its own tools and no Copilot guidance, so no session is created.
				if (method === 'session/new' && Object.keys(extra).length > 0 && error instanceof RpcError && error.code === INVALID_PARAMS_CODE) {
					throw new Error(`The ${this.adapter.displayName} agent refused the session options that turn off its built-in tools and carry the Copilot guidance (${describeError(error)}), so no session was started. Update the agent.`, { cause: error });
				}
				throw this.adapter.mapError?.(error) ?? error;
			}

			// A resume answers without the id: the session keeps its own.
			const sessionId = response?.sessionId ?? sourceId;
			if (!sessionId) {
				throw new Error('The agent opened a session without telling its id.');
			}
			let configOptions = response?.configOptions ?? [];
			configOptions = await this.applyDefaultMode(sessionId, configOptions);
			configOptions = await this.applyModel(sessionId, configOptions, options.model);
			if (this.rpc !== rpc) {
				throw new RpcConnectionClosedError(`The ${this.adapter.displayName} agent was stopped while opening a session.`);
			}
			this.log(`Opened ACP session ${sessionId} (${method}) with ${configOptions.length} config option(s)`);
			return { sessionId, configOptions, models: response?.models };
		} finally {
			this.endOperation();
		}
	}

	/** The adapter's extra fields for opening a session; empty when it has none. */
	private sessionExtras(options: CreateSessionOptions, isNewSession: boolean): Record<string, unknown> {
		if (!this.adapter.sessionParams) {
			return {};
		}
		return this.adapter.sessionParams({
			systemPromptAppend: options.systemPromptAppend,
			model: options.model,
			disableBuiltInTools: this.adapter.disableBuiltInTools?.(this.ctx.settings) ?? false,
			reportEachModelCall: options.reportEachModelCall ?? false,
			isNewSession,
		});
	}

	/**
	 * Puts a freshly opened session in the adapter's mode. A failure propagates,
	 * so a turn never runs in a mode nobody chose.
	 */
	private async applyDefaultMode(sessionId: string, configOptions: readonly AcpConfigOption[]): Promise<readonly AcpConfigOption[]> {
		const mode = this.adapter.defaultSessionMode;
		if (!mode) {
			return configOptions;
		}
		const option = configOptions.find(candidate => candidate.id === 'mode')
			?? configOptions.find(candidate => candidate.category === 'mode');
		if (!option) {
			this.log('The agent offers no mode config option; the session keeps the mode the agent chose.', 'warn');
			return configOptions;
		}
		if (option.currentValue === mode) {
			return configOptions;
		}
		return await this.setConfigOption(sessionId, option.id, mode) ?? configOptions;
	}

	/** ACP has no model field on `session/new`; when the agent offers the model as a config option value, it is set there. */
	private async applyModel(sessionId: string, configOptions: readonly AcpConfigOption[], model: string | undefined): Promise<readonly AcpConfigOption[]> {
		if (!model) {
			return configOptions;
		}
		const option = configOptions.find(candidate => candidate.category === 'model') ?? configOptions.find(candidate => candidate.id === 'model');
		if (!option || option.currentValue === model || !offersValue(option, model)) {
			return configOptions;
		}
		return await this.setConfigOption(sessionId, option.id, model) ?? configOptions;
	}

	/** Releases an agent-side session; best effort, as the method is an ACP extension. */
	async closeSession(sessionId: string): Promise<void> {
		this.cancelOpenPermissions(sessionId);
		this.backgroundTasks.delete(sessionId);
		const rpc = this.rpc;
		if (!rpc) {
			return;
		}
		this.beginOperation();
		try {
			await rpc.request('session/close', { sessionId }, { timeoutMs: CLOSE_SESSION_TIMEOUT_MS });
		} catch {
			// The session is gone either way: an agent that does not know the method
			// drops it when the process exits.
		} finally {
			this.endOperation();
		}
	}

	/**
	 * Sets the model with the agent's own `session/set_model` extension (some
	 * agents take a bracketed `model[effort]` id). The response carries nothing,
	 * so the caller reads the config options back.
	 */
	async setSessionModel(sessionId: string, modelId: string): Promise<void> {
		const rpc = this.requireConnection();
		await rpc.request('session/set_model', { sessionId, modelId }, { timeoutMs: SET_CONFIG_TIMEOUT_MS });
		this.log(`Set session ${sessionId} model ${modelId}`);
	}

	/** Applies a session config option, used to switch the model or the effort of an existing session. */
	async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<readonly AcpConfigOption[] | undefined> {
		const rpc = this.requireConnection();
		const response = await rpc.request<{ configOptions?: readonly AcpConfigOption[] }>('session/set_config_option', { sessionId, configId, value }, { timeoutMs: SET_CONFIG_TIMEOUT_MS });
		this.log(`Set session ${sessionId} option ${configId}=${String(value)}`);
		return response?.configOptions;
	}

	/** Asks the agent to stop the current turn of a session. */
	cancel(sessionId: string): void {
		// ACP requires a cancelled turn to answer its open permission requests.
		this.cancelOpenPermissions(sessionId);
		this.rpc?.notify('session/cancel', { sessionId });
	}

	/** Runs one ACP turn and streams its agent text chunks to `handlers.onText`. */
	async prompt(sessionId: string, blocks: readonly AcpContentBlock[], handlers: PromptHandlers): Promise<PromptResult> {
		const rpc = this.requireConnection();
		this.beginOperation();

		const sink = (update: AcpSessionUpdate) => {
			if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
				const text = update.content?.type === 'text' ? update.content.text : undefined;
				if (text) {
					if (update.sessionUpdate === 'agent_message_chunk') {
						handlers.onText(text);
					} else {
						handlers.onThought?.(text);
					}
				}
			}
			handlers.onUpdate?.(update);
		};
		this.turnSinks.set(sessionId, sink);
		if (handlers.onUsage) {
			this.usageSinks.set(sessionId, handlers.onUsage);
		}

		const cancellation = handlers.token?.onCancellationRequested(() => {
			this.log(`Cancelling ACP session ${sessionId}`);
			this.cancel(sessionId);
		});

		try {
			const response = await rpc.request<AcpPromptResponse>('session/prompt', { sessionId, prompt: blocks });
			return { stopReason: response.stopReason ?? 'end_turn', usage: readTokenUsage(response) };
		} catch (error) {
			this.captureAuthState(error);
			throw this.adapter.mapError?.(error) ?? error;
		} finally {
			cancellation?.dispose();
			if (this.turnSinks.get(sessionId) === sink) {
				this.turnSinks.delete(sessionId);
			}
			this.usageSinks.delete(sessionId);
			if (this.turnSinks.size === 0) {
				this.seenCalls.clear();
			}
			this.endOperation();
		}
	}

	/** Starts an interactive authentication method advertised by the agent. */
	async signInWithMethod(methodId: string): Promise<void> {
		const rpc = await this.ensureStarted();
		if (!this.authMethods.some(method => method.id === methodId)) {
			throw new Error(`Authentication method ${methodId} was not advertised by the agent.`);
		}
		await rpc.request('authenticate', { methodId }, { timeoutMs: 5 * 60_000 });
		this.signInRequired = false;
	}

	/** Kills the agent process, drops every session and notifies listeners. */
	async restart(): Promise<void> {
		this.log(`Restarting the ${this.adapter.displayName} agent`);
		await this.stopProcess();
		this.fastExits = 0;
		this.signInRequired = false;
		this.authStatus = undefined;
		this.authMethods = [];
		this.changeEmitter.fire('restarted');
	}

	/** Whether the session still has a background command or task running, which closing it would kill. */
	hasBackgroundTasks(sessionId: string): boolean {
		return (this.backgroundTasks.get(sessionId)?.size ?? 0) > 0;
	}

	/**
	 * Stops the process once nothing needs it. Unlike {@link restart} it keeps the
	 * sign-in state; the next request starts the agent again.
	 */
	async stopWhenIdle(): Promise<void> {
		if (!this.rpc || this.starting || this.busyOperations > 0) {
			return;
		}
		this.log(`Nothing has used the ${this.adapter.displayName} agent for a while; stopping it. The next request starts it again.`);
		await this.stopProcess();
		// `handleExit` ignores a process that was detached first, so the record is dropped here.
		forgetAgent(this.agentRegistry);
		if (!this.disposed) {
			this.changeEmitter.fire('idle');
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.changeEmitter.dispose();

		// Shutdown cannot wait for the event loop, so the process is killed synchronously.
		const { child } = this.detachProcess(new RpcConnectionClosedError(`The ${this.adapter.displayName} agent was stopped.`));
		if (child?.pid) {
			killTreeSync(child.pid);
		}
		forgetAgent(this.agentRegistry);
	}

	/** Marks the agent as in use, so the idle timer does not stop it under a running request. */
	private beginOperation(): void {
		this.busyOperations++;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private endOperation(): void {
		this.busyOperations--;
		if (this.busyOperations > 0 || this.disposed || !this.rpc) {
			return;
		}
		const minutes = numberSetting(this.ctx.settings, 'idleShutdownMinutes', 30);
		if (minutes <= 0) {
			return;
		}
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			void this.stopWhenIdle();
		}, minutes * 60_000);
		this.idleTimer.unref();
	}

	private get agentRegistry(): string {
		return path.join(this.deps.storageDir, 'agents');
	}

	private async start(): Promise<JsonRpcConnection> {
		const generation = this.generation;
		if (!this.ctx.entryPath) {
			throw new AdapterNotInstalledError(this.adapter.displayName);
		}
		const spec = this.adapter.launch(this.ctx);
		const env = this.childEnv(spec.command, spec.env);

		const strays = killStrayAgents(this.agentRegistry);
		if (this.adapter.install.kind === 'download') {
			strays.push(...await killOrphanedServers(this.ctx.entryPath));
		}
		if (this.disposed || generation !== this.generation) {
			throw new StartSupersededError();
		}
		if (strays.length > 0) {
			this.log(`Stopped ${strays.length} leftover agent process(es) from closed windows: ${strays.join(', ')}`, 'warn');
		}
		this.log(`Starting the ${this.adapter.displayName} agent${this.ctx.apiKey ? ' with the saved API key' : ''}`);
		this.log(`Command ${spec.command} ${spec.args.join(' ')} in ${this.ctx.workspaceFolder}`, 'debug');

		const options: cp.SpawnOptions = {
			cwd: this.ctx.workspaceFolder,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			detached: process.platform !== 'win32',
		};
		let child: cp.ChildProcess;
		if (spec.shell) {
			assertShellSafe(spec.args);
			child = cp.spawn(`"${spec.command}"`, spec.args, { ...options, shell: true });
		} else {
			child = cp.spawn(spec.command, spec.args, options);
		}

		if (!child.pid || !child.stdin || !child.stdout) {
			throw new Error(`Failed to start the ${this.adapter.displayName} agent process.`);
		}

		trackChild(child.pid);
		recordAgent(this.agentRegistry, child.pid);
		this.child = child;
		this.startedAt = Date.now();
		child.on('error', error => this.log(`Agent process error: ${error.message}`, 'error'));
		child.on('exit', (code, signal) => this.handleExit(child, code, signal));
		if (child.stderr) {
			pipeLines(child.stderr, line => this.log(line, levelOfLine(line)));
		}

		const rpc = new JsonRpcConnection(child.stdout, child.stdin, (message, level) => this.log(message, level));
		this.rpc = rpc;
		rpc.onNotification((method, params) => this.handleNotification(method, params));
		rpc.onRequest('session/request_permission', params => this.handlePermissionRequest(params));

		try {
			const response = await rpc.request<AcpInitializeResponse>('initialize', {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
					...this.adapter.clientCapabilities,
				},
				clientInfo: {
					name: 'acp-hub-for-copilot',
					title: 'ACP Hub for Copilot',
					version: this.deps.clientVersion,
				},
			}, { timeoutMs: INITIALIZE_TIMEOUT_MS });

			this.authMethods = response.authMethods ?? [];
			this.log(`Initialized ACP protocol ${response.protocolVersion ?? ACP_PROTOCOL_VERSION} with ${response.agentInfo?.title ?? response.agentInfo?.name ?? this.adapter.displayName} ${response.agentInfo?.version ?? ''}`.trim());
			this.log(`Auth methods: ${this.authMethods.map(method => method.id ?? method.name ?? 'unknown').join(', ') || 'none'}`);
			await this.authenticate(rpc);
			return rpc;
		} catch (error) {
			this.captureAuthState(error);
			this.log(`Failed to initialize the agent: ${describeError(error)}`, 'error');
			// Only this start's own process: a restart may already have replaced it. When the
			// process died, its output usually closes before the exit event arrives, so a
			// failed start is counted here and not in `handleExit`, which never sees it.
			if (this.child === child) {
				if (!isAuthRequiredError(error)) {
					this.fastExits++;
					this.lastFailureAt = Date.now();
				}
				await this.stopProcess();
			}
			throw this.adapter.mapError?.(error) ?? error;
		}
	}

	/** The environment the agent starts with: the host's, the adapter's own, then the adapter's last word on it. */
	private childEnv(command: string, adapterEnv: Record<string, string>): Record<string, string> {
		const base: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env)) {
			if (value !== undefined) {
				base[name] = value;
			}
		}
		let env = { ...base, ...adapterEnv };
		if (this.adapter.mergeConfig) {
			env = this.adapter.mergeConfig(this.ctx.settings, env);
		}
		if (command === process.execPath) {
			// The extension host is Electron, so Code.exe only behaves like node when this is set.
			env.ELECTRON_RUN_AS_NODE = '1';
			const nodeOptions = hideConsoleNodeOptions(this.deps.storageDir, env.NODE_OPTIONS);
			if (nodeOptions !== undefined) {
				env.NODE_OPTIONS = nodeOptions;
			}
		}
		return env;
	}

	/** Some agents refuse sessions until a sign-in method was chosen; the adapter says which call to make. */
	private async authenticate(rpc: JsonRpcConnection): Promise<void> {
		const request = this.adapter.authenticate?.([...this.authMethods], this.ctx.apiKey, this.ctx.settings);
		if (!request) {
			return;
		}
		try {
			await rpc.request('authenticate', request, { timeoutMs: AUTHENTICATE_TIMEOUT_MS });
			this.log(`Authenticated with ${request.methodId}.`);
		} catch (error) {
			this.signInRequired = true;
			this.log(`Authentication with ${request.methodId} failed: ${describeError(error)}`, 'warn');
		}
	}

	private requireConnection(): JsonRpcConnection {
		if (!this.rpc) {
			throw new RpcConnectionClosedError(`The ${this.adapter.displayName} agent is not running.`);
		}
		return this.rpc;
	}

	private handleExit(child: cp.ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (this.child !== child) {
			return;
		}
		if (child.pid) {
			untrackChild(child.pid);
		}
		this.detachProcess(new RpcConnectionClosedError(`The ${this.adapter.displayName} agent exited.`));
		this.log(`Agent exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`, code === 0 || code === null ? 'info' : 'warn');

		this.fastExits = Date.now() - this.startedAt < FAST_EXIT_MS ? this.fastExits + 1 : 0;
		this.lastFailureAt = Date.now();
		forgetAgent(this.agentRegistry);
		if (!this.disposed) {
			this.changeEmitter.fire('exited');
		}
	}

	/** Forgets the process and connection and fails everything that was waiting on them. */
	private detachProcess(reason: Error): { child: cp.ChildProcess | undefined; rpc: JsonRpcConnection | undefined } {
		const { child, rpc } = this;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.child = undefined;
		this.rpc = undefined;
		this.starting = undefined;
		this.generation++;
		this.turnSinks.clear();
		this.usageSinks.clear();
		this.seenCalls.clear();
		this.backgroundTasks.clear();
		for (const sessionId of [...this.openPermissions.keys()]) {
			this.cancelOpenPermissions(sessionId);
		}
		rpc?.dispose(reason);
		return { child, rpc };
	}

	private async stopProcess(): Promise<void> {
		const { child } = this.detachProcess(new RpcConnectionClosedError(`The ${this.adapter.displayName} agent was stopped.`));
		if (child?.pid) {
			await killTree(child.pid);
		}
	}

	private handleNotification(method: string, params: unknown): void {
		if (method === '_auth/status_update') {
			const payload = (params as { authStatus?: unknown } | undefined)?.authStatus;
			this.authStatus = payload;
			const fields = (payload ?? {}) as { kind?: unknown; label?: unknown };
			// Only `none` means signed out: `account` and `api_key`, and any other kind
			// an agent adds later, are credentials of some sort.
			this.signInRequired = fields.kind === 'none';
			// The payload carries the account's email address and organization, which stay out of the log.
			this.log(`_auth/status_update: kind=${String(fields.kind)}${typeof fields.label === 'string' ? ` label=${fields.label}` : ''}`);
			return;
		}

		if (method === 'session/update') {
			const notification = params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
			const update = notification?.update;
			if (!notification?.sessionId || !update) {
				return;
			}
			if (this.trackBackgroundTask(notification.sessionId, update)) {
				return;
			}
			// Tool titles and plan entries can quote commands and file names, so they are debug-level.
			if (update.sessionUpdate === 'tool_call') {
				this.log(`tool_call ${update.toolCallId ?? ''}: ${update.title ?? ''}`.trim(), 'debug');
			} else if (update.sessionUpdate === 'plan') {
				this.log(`plan: ${update.entries?.map(entry => `${entry.status}:${entry.content}`).join(' | ') ?? ''}`, 'debug');
			} else if (update.sessionUpdate === 'usage_update') {
				this.log(`usage: ${update.used ?? '?'}/${update.size ?? '?'} tokens`, 'debug');
			}
			this.turnSinks.get(notification.sessionId)?.(update);
			return;
		}

		const call = this.adapter.modelCallUsage?.(method, params, this.seenCalls);
		if (call) {
			if (call.usage) {
				this.usageSinks.get(call.sessionId)?.(call.usage);
			}
			return;
		}

		this.log(`Unhandled agent notification: ${method}`, 'warn');
	}

	/**
	 * Follows the background commands and tasks an agent reports once the client
	 * advertises it. They arrive after the turn that started them has ended, so
	 * they never reach a turn sink. Returns whether the update was one of them.
	 */
	private trackBackgroundTask(sessionId: string, update: AcpSessionUpdate): boolean {
		const kind = update.sessionUpdate;
		if (kind !== 'async_task_spawned' && kind !== 'async_task_progress' && kind !== 'async_task_state_update') {
			return false;
		}
		const taskId = update.asyncTaskId;
		if (!taskId) {
			return true;
		}
		const running = kind === 'async_task_spawned' || (kind === 'async_task_state_update' && (update.state === 'running' || update.state === 'paused'));
		const ended = kind === 'async_task_state_update' && !running;
		if (running) {
			const tasks = this.backgroundTasks.get(sessionId) ?? new Set<string>();
			tasks.add(taskId);
			this.backgroundTasks.set(sessionId, tasks);
		} else if (ended) {
			const tasks = this.backgroundTasks.get(sessionId);
			tasks?.delete(taskId);
			if (tasks?.size === 0) {
				this.backgroundTasks.delete(sessionId);
			}
		}
		this.log(`Background task ${taskId} in ${sessionId}: ${kind}${update.state ? ` (${update.state})` : ''}; ${this.backgroundTasks.get(sessionId)?.size ?? 0} running.`, 'debug');
		return true;
	}

	private async handlePermissionRequest(params: unknown): Promise<unknown> {
		const request = (params ?? {}) as RequestPermissionParams;
		const options = request.options ?? [];
		const title = request.toolCall?.title ?? request.toolCall?.toolCallId ?? 'a tool';
		const offered = options.map(option => `${option.name} (${option.kind})`).join(', ') || 'none';

		this.log(`Permission requested for "${title}"; options: ${offered}`, 'debug');

		const mode = stringSetting(this.ctx.settings, 'permissionMode', 'auto');
		if (mode === 'auto') {
			const choice = options.find(option => option.kind === 'allow_once')
				?? options.find(option => option.kind === 'allow_always')
				?? options.find(option => option.kind.startsWith('allow'));
			if (choice) {
				this.log(`Auto-approving a permission request with ${choice.optionId}`);
				return { outcome: { outcome: 'selected', optionId: choice.optionId } };
			}
			this.log('No allow option was offered for a permission request; declining', 'warn');
			return { outcome: { outcome: 'cancelled' } };
		}

		const picked = await this.askPermission(request.sessionId, `${this.adapter.displayName} wants to run: ${title}. Offered options: ${offered}.`, options);
		if (!picked) {
			this.log('A permission request was not granted; declining', 'warn');
			return { outcome: { outcome: 'cancelled' } };
		}
		this.log(`User chose ${picked.optionId} for a permission request`);
		return { outcome: { outcome: 'selected', optionId: picked.optionId } };
	}

	/**
	 * Shows the permission prompt. Resolves with `undefined` when the user
	 * dismisses it, when the turn is cancelled, or when nobody answers in time.
	 */
	private askPermission(sessionId: string | undefined, message: string, options: readonly PermissionOption[]): Promise<PermissionOption | undefined> {
		return new Promise<PermissionOption | undefined>(resolve => {
			let release = () => { };
			const settle = (choice: PermissionOption | undefined) => {
				clearTimeout(timer);
				release();
				resolve(choice);
			};

			const timer = setTimeout(() => {
				this.log('A permission prompt timed out; declining', 'warn');
				settle(undefined);
			}, PERMISSION_TIMEOUT_MS);

			if (sessionId) {
				const waiting = this.openPermissions.get(sessionId) ?? new Set<() => void>();
				const cancel = () => settle(undefined);
				waiting.add(cancel);
				this.openPermissions.set(sessionId, waiting);
				release = () => {
					waiting.delete(cancel);
					if (waiting.size === 0 && this.openPermissions.get(sessionId) === waiting) {
						this.openPermissions.delete(sessionId);
					}
				};
			}

			if (!this.deps.askPermission) {
				settle(undefined);
				return;
			}
			this.deps.askPermission(message, options.map(option => option.name))
				.then(index => settle(index === undefined ? undefined : options[index]), () => settle(undefined));
		});
	}

	private cancelOpenPermissions(sessionId: string): void {
		for (const cancel of [...(this.openPermissions.get(sessionId) ?? [])]) {
			cancel();
		}
	}

	private captureAuthState(error: unknown): void {
		if (isAuthRequiredError(error)) {
			this.signInRequired = true;
			this.log(`The ${this.adapter.displayName} agent requires sign-in. Sign in from the ACP Hub sidebar, then restart the agent.`, 'warn');
		}
	}

	private log(message: string, level: LogLevel = 'info'): void {
		this.deps.log(message, level);
	}
}

/** Checks the arguments of a program that will go through `cmd.exe`, where quoting cannot be trusted. */
function assertShellSafe(args: readonly string[]): void {
	for (const argument of args) {
		if (!SHELL_SAFE_ARGUMENT.test(argument)) {
			throw new Error(`The argument "${argument}" cannot be passed to a program started through the shell.`);
		}
	}
}

function offersValue(option: AcpConfigOption, value: string): boolean {
	for (const choice of option.options ?? []) {
		if ('group' in choice) {
			if (choice.options.some(inner => inner.value === value)) {
				return true;
			}
		} else if (choice.value === value) {
			return true;
		}
	}
	return false;
}

function numberSetting(settings: AgentSettings, key: string, fallback: number): number {
	const value = settings[key];
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringSetting(settings: AgentSettings, key: string, fallback: string): string {
	const value = settings[key];
	return typeof value === 'string' ? value : fallback;
}

function describeError(error: unknown): string {
	if (error instanceof RpcError) {
		return `${error.message} (code ${error.code})`;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the token usage of a finished turn. `_meta.quota.token_count` is the
 * agent's own per-turn breakdown; the `usage` field is the standard place a
 * wider range of agents report it.
 */
export function readTokenUsage(response: AcpPromptResponse): AcpTokenUsage | undefined {
	const quota = response._meta?.quota?.token_count;
	const usage = quota ?? response.usage;
	if (!usage) {
		return undefined;
	}

	const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
	const inputTokens = count(usage.inputTokens);
	const outputTokens = count(usage.outputTokens);
	// The quota breakdown names the cache counts `cachedInputTokens` and
	// `cacheWriteInputTokens`; the standard `usage` field uses `cachedReadTokens`
	// and `cachedWriteTokens`.
	const cachedReadTokens = count(quota?.cachedInputTokens ?? usage.cachedReadTokens);
	const cachedWriteTokens = count(quota?.cacheWriteInputTokens ?? usage.cachedWriteTokens);

	return {
		inputTokens,
		outputTokens,
		cachedReadTokens,
		cachedWriteTokens,
		totalTokens: count(usage.totalTokens) || inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
		reasoningOutputTokens: typeof usage.reasoningOutputTokens === 'number' ? usage.reasoningOutputTokens : undefined,
	};
}
