import type { AcpAuthMethod, AcpTokenUsage, ForkPoint } from './agentClient';
import type { Log } from './logging';

/** Values of an agent's settings, after defaults are applied. */
export type AgentSettings = Record<string, string | number | boolean | string[]>;

export interface InstallContext {
	storageDir: string;
	log: Log;
	/** `fraction` is the share done, from 0 to 100, when it is known. */
	progress(message: string, fraction?: number): void;
}

/**
 * How an agent gets onto the machine. `npm` installs from the lockfile in
 * `manifestDirectory` (relative to the extension folder) and finds the
 * package's `bin` entry. `download` returns the path of the program it put in
 * place. `existing-cli` expects `command` on the PATH.
 */
export type InstallSpec =
	| { kind: 'npm'; packageName: string; version: string; manifestDirectory: string; entry?: string }
	| { kind: 'download'; version: string; find(ctx: InstallContext): Promise<string | undefined>; install(ctx: InstallContext): Promise<string>; /** Whether an older install is in use and the current version is not there yet; the extension then fetches it unasked. */ needsUpdate?(ctx: InstallContext): Promise<boolean> }
	| { kind: 'existing-cli'; command: string };

/** What a conversation fork needs: the session to copy, where to cut it, and the folder the copy belongs to. */
export interface ConversationForkRequest {
	readonly sessionId: string;
	readonly point: ForkPoint;
	readonly cwd: string;
	/**
	 * Whether the fork may keep the source's id (so its prompt cache still serves the conversation).
	 * That needs the agent to read the source afresh, which only a new process does; when another
	 * chat is in the middle of a turn the fork takes an id of its own instead.
	 */
	readonly keepSourceId: boolean;
}

/**
 * What a fork made. `sessionId` is the session the forked chat goes on in. A forker that keeps the
 * source's id for the fork (an agent whose prompt names the conversation, so only that id keeps its
 * prompt cache) puts the source's whole conversation in a copy and names it in `sourceMovedTo`.
 */
export interface ForkResult {
	readonly sessionId: string;
	readonly sourceMovedTo?: string;
}

/**
 * A way to fork a stored conversation for an agent that does not answer `session/fork`: a program
 * on the machine copies it, and the agent then opens the copy with `session/resume`.
 */
export interface ConversationForker {
	/** The program that forks, or `undefined` when this machine has none. `agentProgram` is the program the agent was launched with. */
	locate(settings: AgentSettings, log: Log, agentProgram: string | undefined): Promise<string | undefined>;
	/** Forks the conversation at the fork point; the provider closes every chat on the source first. */
	fork(program: string, request: ConversationForkRequest, log: Log): Promise<ForkResult>;
	/** What the user is told once, the first time a chat needs a fork and `locate` finds nothing. */
	missing: { message: string; helpLabel: string; helpUrl: string; declineLabel: string };
}

export interface LaunchContext {
	/** What the install produced: the adapter's entry file, the downloaded program, or the CLI command. */
	entryPath: string;
	/** The folder holding the install; empty for an existing CLI. */
	installDir: string;
	/** A folder of the agent's own in the extension's global storage, for state that must survive updates. */
	storageDir: string;
	settings: AgentSettings;
	apiKey?: string;
	workspaceFolder: string;
}

export interface LaunchSpec {
	command: string;
	args: string[];
	env: Record<string, string>;
	shell?: boolean;
}

export type AuthMethodSpec =
	| { kind: 'oauth-browser'; label: string; terminalCommand?: string[]; agentMethodId?: string; browserAuthPreference?: string }
	| { kind: 'api-key'; label: string; envVar: string; agentMethodId?: string; /** Start of a usual key; a key without it only gets a warning. */ keyPrefix?: string }
	| { kind: 'agent-managed'; label: string };

export interface UsageWindow {
	label: string;
	usedPercent: number;
	/** When the window resets, as text the agent or the adapter rendered. */
	resets?: string;
}

/** An account without plan limits has no windows and says why in `note`. */
export interface UsageReading {
	plan?: string;
	windows: UsageWindow[];
	note?: string;
}

export interface UsageContext {
	launch: LaunchContext;
	/** Starts the agent and opens its warm session, which can take a while; resolves `false` when the agent is not set up. */
	ready?(): Promise<boolean>;
	/** Sends a prompt to a warm agent session and returns the reply text; `undefined` when the agent is not set up. */
	askAgent(prompt: string): Promise<string | undefined>;
}

export interface UsageSource {
	read(ctx: UsageContext, signal: AbortSignal): Promise<UsageReading | undefined>;
}

export interface SettingSpec {
	key: string;
	type: 'string' | 'number' | 'boolean' | 'enum' | 'string-list';
	label: string;
	description: string;
	default: string | number | boolean | string[];
	options?: string[];
	optionDescriptions?: string[];
}

/** A model the agent offers, before it is turned into a picker entry. */
export interface ModelChoice {
	value: string;
	name: string;
	description?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
}

/** What the agent reported when a session was created. */
export interface AgentSessionInfo {
	models: ModelChoice[];
	effortLevels: string[];
}

/**
 * What the last model call of a turn sent. For an agent whose protocol reports only the sums of a
 * whole turn, which add up every call and so say nothing about the context the agent holds.
 */
export interface LastModelCall {
	/** The tokens the call sent: fresh plus cached. */
	readonly promptTokens: number;
	readonly cachedTokens: number;
}

export interface SessionParamsInput {
	/** Text appended to the agent's own system prompt. */
	systemPromptAppend?: string;
	/**
	 * True when the agent's `replaceSystemPrompt` setting is on. An adapter that declares that
	 * setting decides what replacing means for its agent; one that does not declare it never sees true.
	 */
	replaceSystemPrompt: boolean;
	model?: string;
	/** True when `disableBuiltInTools(settings)` said so. */
	disableBuiltInTools: boolean;
	reportEachModelCall: boolean;
	/** True for a session that is never resumed, so the agent need not keep a transcript of it. */
	ephemeral?: boolean;
	/** The agent's settings, for an adapter whose session options depend on one. */
	settings?: AgentSettings;
	/** `session/resume` and `session/fork` may refuse a system prompt that `session/new` takes. */
	isNewSession: boolean;
}

export interface AuthenticateRequest {
	methodId: string;
	_meta?: Record<string, unknown>;
}

/** How an agent's models are described in the model picker. */
export interface ModelPolicy {
	/** The picker's detail line for every model. */
	detail: string;
	/** `modelName` is the display name; most agents ignore it. */
	familyOf(modelValue: string, modelName: string): string;
	contextWindowOf(modelValue: string, modelName: string): number;
	maxOutputTokens: number;
	/** The agent's config option id for the thinking effort. */
	effortConfigId: string;
	effortLabel(value: string): string;
	effortDescription(value: string): string;
	/** Reads the effort levels from the agent's model list, when it offers no effort config option. */
	effortLevelsFromModels?(models: readonly { modelId?: string }[]): string[];
	defaultEffort(levels: readonly string[]): string;
	fallbackTooltip(name: string): string;
	thinkingDescription: string;
	/** Whether the context size a turn reports (`usage_update.size`) replaces the window the picker advertises. */
	refineWindowFromUsage?: boolean;
}

/**
 * Everything the core needs to know about one agent. The core never looks at
 * the agent's id; every difference between agents is expressed here.
 */
export interface AgentAdapter {
	id: string;
	displayName: string;
	vendor: string;
	install: InstallSpec;
	launch(ctx: LaunchContext): LaunchSpec;
	findCommandOverride?(settings: AgentSettings): string | undefined;
	auth: AuthMethodSpec[];
	settings: SettingSpec[];
	modelPolicy: ModelPolicy;
	/** The two sentences of the session prompt that differ per agent (see `createSessionPrompt`). */
	systemPrompt: { toolAccess: string; listRequiredArguments: boolean };
	listModels?(session: AgentSessionInfo): ModelChoice[];
	usage?: UsageSource;
	/** Whether the token counts the agent reports tell what the prompt cache served; `false` for one whose cache counts are always 0, so no hit rate is claimed. */
	reportsCache?: boolean;
	rebuildExpiredSessions?: boolean;
	/** Whether a chat copied from another chat, or edited above its last message, can continue the stored conversation with `session/fork`; the agent must also advertise it. */
	forkChats?: boolean;
	/** Forks chats by other means than `session/fork`, for an agent that lacks it; used only where the program is installed. */
	forker?: ConversationForker;
	/**
	 * Whether a fork that rewound the source conversation needs the agent restarted before the copy is
	 * opened, for an agent that keeps every conversation it opened in memory and never reads one again.
	 */
	restartAfterFork?: boolean;
	/** Whether the agent fetches the tool list again on `tools/list_changed`, so a changed tool set needs no new session. */
	refreshesTools?: boolean;
	/** How long (ms) a tool call may wait for Copilot to pick it up before it is failed; absent waits for as long as the agent does. */
	toolWaitTimeoutMs?: number;
	/** The most characters of text a tool result may carry to the agent; more is cut with a note on how to read the rest. Absent passes results whole. */
	maxToolResultChars?: number;
	/** Whether the session that reads the model list must declare the tool bridge (the agent's own config names it). */
	declaresBridgeOnModelLookup?: boolean;
	/** Whether the agent's own tools must be turned off for this session (the chat's tools are used instead). */
	disableBuiltInTools?(settings: AgentSettings): boolean;
	/** Turns an error from the agent into the error the caller should see; `undefined` keeps the original. */
	mapError?(error: unknown): Error | undefined;
	/** Gets the whole child environment (process env plus `launch().env`) and returns the one to spawn with; may also remove variables. */
	mergeConfig?(settings: AgentSettings, env: Record<string, string>): Record<string, string>;
	/** Extra fields for `session/new` and `session/resume` (for example `_meta`), given the options the client knows. */
	sessionParams?(options: SessionParamsInput): Record<string, unknown>;
	/** Value the session's `mode` config option is set to after a session is opened. */
	defaultSessionMode?: string;
	/** Merged into `clientCapabilities` of `initialize`. */
	clientCapabilities?: Record<string, unknown>;
	/** Replaces the `clientInfo` identity sent on `initialize`, for agents that decide what to offer by client. */
	clientIdentity?: { name: string; title: string };
	/** Whether a terminal sign-in begun at `startedAt` (ms) has already succeeded, for a login program that stays open afterwards. */
	signInCompleted?(startedAt: number): boolean;
	/** Picks the `authenticate` call to make after `initialize`, or `undefined` for none. */
	authenticate?(methods: AcpAuthMethod[], apiKey: string | undefined, settings?: AgentSettings): AuthenticateRequest | undefined;
	/**
	 * The last model call of a session so far, for an agent that reports no `usage_update` and only
	 * the sums of a turn. Read when a turn reports its usage, so the context the agent holds is
	 * reported as it is rather than as the sum of every call of the turn.
	 */
	lastModelCall?(sessionId: string): Promise<LastModelCall | undefined>;
	/**
	 * Reads the usage of one model call from an agent-specific notification; called for every notification
	 * the client does not know. Returns `undefined` when the notification is not the adapter's, otherwise the
	 * session it belongs to and the usage (absent for a call already counted; `seen` remembers call ids).
	 */
	modelCallUsage?(method: string, params: unknown, seen: Set<string>): { sessionId: string; usage?: AcpTokenUsage } | undefined;
	systemPromptNote?: string;
}
