import type { AcpAuthMethod } from '../core/agentClient';
import type { AgentAdapter, AgentSettings, AuthenticateRequest, LaunchContext, LaunchSpec, SessionParamsInput, UsageContext, UsageReading, UsageSource, UsageWindow } from '../core/adapter';
import { hideConsoleNodeOptions } from '../core/hideConsole';
import { REGISTRY, registryAgent } from '../core/registry';
import { vendorOf } from '../core/vendors';
import { ensureCodexHome } from './codexHome';
import { codexModelPolicy } from './codexModels';
import { readRateLimits, type RateLimitRead, type RateWindow } from './codexRateLimits';
import { booleanSetting, stringSetting } from './settingValues';

const ID = 'codex';
const ADAPTER_VERSION = '2.3.0';

/**
 * The mode every session runs in. Codex's own tools are gone (see
 * `DISABLED_BUILT_IN_FEATURES` and `EXCLUDED_CODE_MODE_NAMESPACES`), so `mcp__vscode__*` is the
 * only tool it can reach and every change still goes through Copilot's tools. `agent` ("Auto
 * review") is avoided: it runs a second model call to review every tool call, which costs
 * several seconds and tokens per call. `agent-full-access` has no reviewer, and the sandbox
 * it lifts has nothing left to guard.
 */
const SESSION_MODE = 'agent-full-access';

/**
 * Codex has no single switch for its own tools, so each feature that registers
 * one is turned off. Copilot's tools reach Codex only through the bridge; a
 * Codex shell would run beside Copilot's approvals and diffs instead of in them.
 */
const DISABLED_BUILT_IN_FEATURES: Readonly<Record<string, false>> = {
	shell_tool: false,
	unified_exec: false,
	view_image: false,
	image_generation: false,
	multi_agent: false,
	multi_agent_v2: false,
	goals: false,
	sleep_tool: false,
	tool_suggest: false,
	apps: false,
	browser_use: false,
	browser_use_external: false,
	computer_use: false,
	in_app_browser: false,
	memories: false,
	// Code mode's `exec` runs JavaScript that calls tools; without its host it fails closed.
	code_mode_host: false,
	plugins: false,
	skill_search: false,
	default_mode_request_user_input: false,
	request_permissions_tool: false,
	send_message_to_user_async: false,
	agent_message_board: false,
	runtime_agent_instances: false,
	artifact: false,
	multi_env_copy_file: false,
	standalone_web_search: false,
};

/**
 * The tool namespaces code mode must not offer: `functions` holds `apply_patch` and the MCP
 * resource tools, `clock` the time tool. An MCP tool's namespace is `mcp__<server>__`, so the
 * bridge keeps its route through `exec`, which can then reach nothing else.
 */
const EXCLUDED_CODE_MODE_NAMESPACES: readonly string[] = ['functions', 'clock'];

/**
 * The `model_context_window` asked for when `maxContextWindow` is on. Codex has
 * one such value for all models and clamps it to each model's own `max_context_window`,
 * so a number no model reaches means "the most this model allows".
 */
const RAISED_CONTEXT_WINDOW = 10_000_000;

function usesChatGptOnly(settings: AgentSettings): boolean {
	return stringSetting(settings, 'authPreference', 'auto') === 'chatgpt';
}

function launch(ctx: LaunchContext): LaunchSpec {
	const env: Record<string, string> = {
		INITIAL_AGENT_MODE: SESSION_MODE,
		CODEX_HOME: ensureCodexHome(ctx.storageDir),
	};
	if (ctx.apiKey && !usesChatGptOnly(ctx.settings)) {
		env.CODEX_API_KEY = ctx.apiKey;
	}
	return { command: process.execPath, args: [ctx.entryPath], env };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The `CODEX_CONFIG` the user set; the adapter fails `session/new` outright on a value it cannot read, so it is refused here. */
function readUserConfig(existing: string | undefined): Record<string, unknown> {
	if (!existing) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(existing);
	} catch {
		throw new Error('The CODEX_CONFIG environment variable is not valid JSON. Fix it or remove it, then restart the Codex agent.');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('The CODEX_CONFIG environment variable is not a JSON object. Fix it or remove it, then restart the Codex agent.');
	}
	return parsed as Record<string, unknown>;
}

/**
 * Adds this extension's own settings to the `CODEX_CONFIG` the user may have set,
 * and keeps every other key.
 *
 * `mcp_servers` is left alone on purpose. The bridge is handed to the agent as a
 * session's MCP server, and the adapter turns that into Codex's `mcp_servers.vscode`
 * entry, which carries no `tool_timeout_sec`. Naming the server here does not add a
 * timeout to it: Codex refuses a `mcp_servers` entry with no transport ("invalid
 * transport"), so `session/new` fails and the agent offers no models at all, and the
 * adapter skips a session's server whose name the config already defines.
 */
export function mergeCodexConfig(existing: string | undefined, maxContextWindow: boolean): string {
	const config = readUserConfig(existing);
	if (maxContextWindow) {
		config.model_context_window = RAISED_CONTEXT_WINDOW;
	}
	const features = { ...asRecord(config.features), ...DISABLED_BUILT_IN_FEATURES };
	// Code mode stays on: it is the only way the model reaches the bridge's tools.
	features.code_mode = { ...asRecord(features.code_mode), enabled: true, excluded_tool_namespaces: EXCLUDED_CODE_MODE_NAMESPACES };
	config.features = features;
	config.tools = { ...asRecord(config.tools), experimental_request_user_input: { enabled: false } };
	config.agents = { ...asRecord(config.agents), enabled: false };
	config.web_search = 'disabled';
	return JSON.stringify(config);
}

/**
 * Keeps the Claude and Anthropic variables a sibling agent may have left in the
 * environment away from Codex, and withholds the OpenAI keys of the shell: only
 * the saved key (set by `launch`) is a credential of this extension.
 */
function mergeConfig(settings: AgentSettings, env: Record<string, string>): Record<string, string> {
	const merged = { ...env };
	delete merged.ANTHROPIC_API_KEY;
	delete merged.MCP_TOOL_TIMEOUT;
	delete merged.CLAUDE_AGENT_LOGS;
	for (const name of Object.keys(merged)) {
		if (name.startsWith('CLAUDE_CODE_')) {
			delete merged[name];
		}
	}

	delete merged.OPENAI_API_KEY;
	if (usesChatGptOnly(settings)) {
		delete merged.CODEX_API_KEY;
	}

	merged.CODEX_CONFIG = mergeCodexConfig(merged.CODEX_CONFIG, booleanSetting(settings, 'maxContextWindow'));
	return merged;
}

/**
 * The key in the child's environment is not a credential the adapter reads on
 * its own, so the API-key method has to be selected as well, before any session work.
 */
function authenticate(_methods: AcpAuthMethod[], apiKey: string | undefined, settings: AgentSettings = {}): AuthenticateRequest | undefined {
	if (!apiKey || usesChatGptOnly(settings)) {
		return undefined;
	}
	return { methodId: 'api-key', _meta: { 'api-key': { apiKey } } };
}

/** Only `session/new` may carry a system prompt: `session/resume` and `session/fork` answer `-32602` for a session with no persisted rollout yet. */
function sessionParams(input: SessionParamsInput): Record<string, unknown> {
	if (!input.isNewSession || !input.systemPromptAppend) {
		return {};
	}
	return { systemPrompt: { mode: 'append', content: [{ type: 'text', text: input.systemPromptAppend }] } };
}

const roundToTenth = (value: number): number => Math.round(value * 10) / 10;

function resetText(resetsAt: number | null): string | undefined {
	if (resetsAt === null) {
		return undefined;
	}
	// The app server counts seconds.
	return new Date(resetsAt * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

function windowOf(label: string, window: RateWindow | undefined): UsageWindow[] {
	if (!window) {
		return [];
	}
	return [{ label, usedPercent: roundToTenth(window.usedPercent), resets: resetText(window.resetsAt) }];
}

/** Maps what one read of the plan limits found to what the sidebar shows; a failed read throws. */
export function usageFromRateLimits(read: RateLimitRead): UsageReading {
	if (read.kind === 'failed') {
		throw new Error(`Could not read the Codex plan limits: ${read.reason}`);
	}
	if (read.kind === 'no-plan') {
		return { windows: [], note: 'This Codex account has no ChatGPT plan limits (an API key is billed per token).' };
	}
	return { windows: [...windowOf('5-hour', read.windows.fiveHour), ...windowOf('Weekly', read.windows.weekly)] };
}

const codexUsage: UsageSource = {
	async read(ctx: UsageContext): Promise<UsageReading | undefined> {
		const storageDir = ctx.launch.storageDir;
		const read = await readRateLimits(ctx.launch.entryPath, {
			adapterVersion: ADAPTER_VERSION,
			codexHome: ensureCodexHome(storageDir),
			nodeOptions: hideConsoleNodeOptions(storageDir, process.env.NODE_OPTIONS),
		});
		return usageFromRateLimits(read);
	},
};

const registry = registryAgent(ID);

export const codexAdapter: AgentAdapter = {
	id: ID,
	displayName: registry.displayName,
	vendor: vendorOf(ID),
	install: { kind: 'npm', packageName: '@agentclientprotocol/codex-acp', version: ADAPTER_VERSION, manifestDirectory: 'adapters/codex' },
	launch,
	auth: [
		// The agent runs this sign-in itself (`authenticate` with its `chat-gpt` method).
		{ kind: 'oauth-browser', label: 'ChatGPT account', agentMethodId: 'chat-gpt', browserAuthPreference: 'chatgpt' },
		{ kind: 'api-key', label: 'OpenAI API key', envVar: 'CODEX_API_KEY', keyPrefix: 'sk-' },
	],
	settings: [...REGISTRY.commonSettings, ...registry.settings],
	modelPolicy: codexModelPolicy,
	systemPrompt: {
		toolAccess: 'The tools whose names start with `mcp__vscode__` are VS Code\'s own and act on the user\'s workspace.',
		listRequiredArguments: false,
	},
	usage: codexUsage,
	mergeConfig,
	sessionParams,
	defaultSessionMode: SESSION_MODE,
	authenticate,
};
