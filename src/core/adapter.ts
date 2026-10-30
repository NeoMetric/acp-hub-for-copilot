import type { Log } from './logging';

/** Values of an agent's settings, after defaults are applied. */
export type AgentSettings = Record<string, string | number | boolean>;

export interface InstallContext {
	storageDir: string;
	log: Log;
	progress(message: string): void;
}

export type InstallSpec =
	| { kind: 'npm'; packageName: string; version: string; entryFile?: string }
	| { kind: 'download'; download: (ctx: InstallContext) => Promise<string> }
	| { kind: 'existing-cli'; command: string };

export interface LaunchContext {
	installDir: string;
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
	| { kind: 'oauth-browser'; label: string; terminalCommand?: string[] }
	| { kind: 'api-key'; label: string; envVar: string }
	| { kind: 'agent-managed'; label: string };

export interface UsageWindow {
	label: string;
	usedPercent: number;
	resetsAt?: number;
}

export interface UsageReading {
	windows: UsageWindow[];
	note?: string;
}

export interface UsageSource {
	read(ctx: LaunchContext, signal: AbortSignal): Promise<UsageReading>;
}

export interface SettingSpec {
	key: string;
	type: 'string' | 'number' | 'boolean' | 'enum';
	label: string;
	default: string | number | boolean;
	options?: string[];
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
 * Everything the core needs to know about one agent. The core never looks at
 * the agent's id; every difference between agents is expressed here.
 */
export interface AgentAdapter {
	id: string;
	displayName: string;
	vendor: string;
	install: InstallSpec;
	launch(ctx: LaunchContext): LaunchSpec;
	auth: AuthMethodSpec[];
	settings: SettingSpec[];
	listModels?(session: AgentSessionInfo): ModelChoice[];
	usage?: UsageSource;
	rebuildExpiredSessions?: boolean;
	disableBuiltInTools?: boolean;
	mapError?(error: unknown): Error | undefined;
	mergeConfig?(settings: AgentSettings, env: Record<string, string>): Record<string, string>;
	systemPromptNote?: string;
}
