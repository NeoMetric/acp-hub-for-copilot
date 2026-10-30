import type { AcpAuthMethod, AcpTokenUsage } from './agentClient';
import type { Log } from './logging';

/** Values of an agent's settings, after defaults are applied. */
export type AgentSettings = Record<string, string | number | boolean | string[]>;

export interface InstallContext {
	storageDir: string;
	log: Log;
	progress(message: string): void;
}

/**
 * How an agent gets onto the machine. `npm` installs from the lockfile in
 * `manifestDirectory` (relative to the extension folder) and finds the
 * package's `bin` entry. `download` returns the path of the program it put in
 * place. `existing-cli` expects `command` on the PATH.
 */
export type InstallSpec =
	| { kind: 'npm'; packageName: string; version: string; manifestDirectory: string; entry?: string }
	| { kind: 'download'; version: string; find(ctx: InstallContext): Promise<string | undefined>; install(ctx: InstallContext): Promise<string> }
	| { kind: 'existing-cli'; command: string };

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

export interface SessionParamsInput {
	/** Text appended to the agent's own system prompt. */
	systemPromptAppend?: string;
	model?: string;
	/** True when `disableBuiltInTools(settings)` said so. */
	disableBuiltInTools: boolean;
	reportEachModelCall: boolean;
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
	rebuildExpiredSessions?: boolean;
	/** Whether a chat copied from another chat can continue the stored conversation with `session/fork`. */
	forkChats?: boolean;
	/** How long (ms) a tool call may wait for Copilot to pick it up before it is failed; absent waits for as long as the agent does. */
	toolWaitTimeoutMs?: number;
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
	/** Picks the `authenticate` call to make after `initialize`, or `undefined` for none. */
	authenticate?(methods: AcpAuthMethod[], apiKey: string | undefined, settings?: AgentSettings): AuthenticateRequest | undefined;
	/**
	 * Reads the usage of one model call from an agent-specific notification; called for every notification
	 * the client does not know. Returns `undefined` when the notification is not the adapter's, otherwise the
	 * session it belongs to and the usage (absent for a call already counted; `seen` remembers call ids).
	 */
	modelCallUsage?(method: string, params: unknown, seen: Set<string>): { sessionId: string; usage?: AcpTokenUsage } | undefined;
	systemPromptNote?: string;
}
