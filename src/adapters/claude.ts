import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AcpTokenUsage } from '../core/protocol';
import type { AgentAdapter, AgentSettings, LaunchContext, LaunchSpec, SessionParamsInput } from '../core/adapter';
import { HOST_IDENTITY } from '../core/hostIdentity';
import { nativeSessionPolicy } from '../core/nativeSessionPolicy';
import { REGISTRY, registryAgent } from '../core/registry';
import type { SessionPolicy } from '../core/sessionPolicy';
import { vendorOf } from '../core/vendors';
import { claudeModelPolicy } from './claudeModels';
import { claudeUsage } from './claudeUsage';
import { booleanSetting, stringSetting } from './settingValues';

const ID = 'claude';

/** How long the agent waits for one tool call that Copilot runs; the limit exists only to bound a call that is lost. */
const TOOL_CALL_TIMEOUT_MS = 24 * 60 * 60_000;

function launch(ctx: LaunchContext): LaunchSpec {
	const env: Record<string, string> = {
		// The memory of the chat belongs to the host, whose memory tool the agent reaches
		// over the bridge. The agent's own memory directory would be a second store that
		// the user never sees, so it is turned off.
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
		CLAUDE_AGENT_LOGS: path.join(ctx.storageDir, 'logs'),
	};
	// A saved key wins over one in the environment and over a signed-in account.
	if (ctx.apiKey && stringSetting(ctx.settings, 'authPreference', 'auto') !== 'oauth') {
		env.ANTHROPIC_API_KEY = ctx.apiKey;
	}
	return { command: process.execPath, args: [ctx.entryPath], env };
}

function mergeConfig(settings: AgentSettings, env: Record<string, string>): Record<string, string> {
	const merged = { ...env };
	if (stringSetting(settings, 'authPreference', 'auto') === 'oauth') {
		delete merged.ANTHROPIC_API_KEY;
	}
	// The agent gives up on a tool call after 60 seconds by default, but a call waits for
	// Copilot to run the tool, which can take as long as the user needs to answer a
	// question or approve a command. A value the user already set is kept.
	const toolSearch = stringSetting(settings, 'toolSearch', 'default');
	if (toolSearch === 'on' || toolSearch === 'off') {
		merged.ENABLE_TOOL_SEARCH = toolSearch === 'on' ? 'true' : 'false';
	}
	merged.MCP_TOOL_TIMEOUT ??= String(TOOL_CALL_TIMEOUT_MS);
	merged.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT ??= String(TOOL_CALL_TIMEOUT_MS);
	return merged;
}

function sessionParams(input: SessionParamsInput): Record<string, unknown> {
	const claudeCodeOptions: Record<string, unknown> = {
		// An empty list removes every built-in tool; the adapter reads `disableBuiltInTools`
		// as a legacy shorthand for the same, so both are sent and neither can be dropped silently.
		// Tool search is the one exception: the agent loads every tool in full when its
		// search tool is missing, so turning tool search on keeps that one.
		tools: stringSetting(input.settings ?? {}, 'toolSearch', 'default') === 'on' ? ['ToolSearch'] : [],
		allowedTools: ['mcp__vscode__*'],
		strictMcpConfig: true,
		settingSources: [],
	};
	if (input.model) {
		claudeCodeOptions.model = input.model;
	}
	if (input.ephemeral) {
		// Otherwise every session, even a `/usage` read, leaves a transcript under ~/.claude/projects.
		claudeCodeOptions.persistSession = false;
	} else if (booleanSetting(input.settings ?? {}, 'showThinking', true)) {
		// Recent models leave the thinking text out of the stream unless asked, so the chat would show none.
		claudeCodeOptions.thinking = { type: 'adaptive', display: 'summarized' };
	}

	const claudeCode: Record<string, unknown> = { options: claudeCodeOptions };
	if (input.reportEachModelCall) {
		// Without this the cache figures of a turn only arrive with its last
		// message; the agent then also sends each `assistant` message whole.
		claudeCode.emitRawSDKMessages = [{ type: 'assistant' }];
	}

	const meta: Record<string, unknown> = { disableBuiltInTools: true, claudeCode };
	if (input.replaceSystemPrompt) {
		// A string replaces the Claude Code prompt; the agent keeps one line of its own identity.
		// A request without tools has no prompt of its own, but must not fall back to the preset.
		meta.systemPrompt = input.systemPromptAppend ?? HOST_IDENTITY;
	} else if (input.systemPromptAppend) {
		meta.systemPrompt = { append: input.systemPromptAppend };
	}
	return { _meta: meta };
}

/**
 * Reads the token usage of one model call, from the raw `assistant` message the
 * agent sends when a session asks for its messages. `undefined` for anything
 * else, and for a call a subagent made, which is not part of the chat's own
 * conversation.
 */
export function modelCallUsageOf(message: unknown, seen?: Set<string>): AcpTokenUsage | undefined {
	const raw = message as { type?: unknown; parent_tool_use_id?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> } } | undefined;
	if (!raw || raw.type !== 'assistant' || raw.parent_tool_use_id) {
		return undefined;
	}

	// The agent sends one message per content block of a call, each repeating the call's usage.
	const id = raw.message?.id;
	if (seen && typeof id === 'string') {
		if (seen.has(id)) {
			return undefined;
		}
		seen.add(id);
	}

	const usage = raw.message?.usage;
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}

	const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
	const inputTokens = count(usage.input_tokens);
	const outputTokens = count(usage.output_tokens);
	const cachedReadTokens = count(usage.cache_read_input_tokens);
	const cachedWriteTokens = count(usage.cache_creation_input_tokens);
	const totalTokens = inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens;
	if (totalTokens === 0) {
		return undefined;
	}

	const details = usage.output_tokens_details as { thinking_tokens?: unknown } | undefined;
	return {
		inputTokens,
		outputTokens,
		cachedReadTokens,
		cachedWriteTokens,
		totalTokens,
		reasoningOutputTokens: typeof details?.thinking_tokens === 'number' ? details.thinking_tokens : undefined,
	};
}

function modelCallUsage(method: string, params: unknown, seen: Set<string>): { sessionId: string; usage?: AcpTokenUsage } | undefined {
	if (method !== '_claude/sdkMessage') {
		return undefined;
	}
	const notification = params as { sessionId?: string; message?: unknown } | undefined;
	const sessionId = notification?.sessionId ?? '';
	return { sessionId, usage: modelCallUsageOf(notification?.message, seen) };
}

/** The login program stays open after it succeeds, so a rewritten credentials file is what says it is done. */
function signInCompleted(startedAt: number): boolean {
	const directory = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
	try {
		return fs.statSync(path.join(directory, '.credentials.json')).mtimeMs >= startedAt;
	} catch {
		return false;
	}
}

const registry = registryAgent(ID);

/**
 * Claude reuses a stored conversation by forking it whenever a chat is copied or edited, and it takes
 * a changed tool list in place instead of needing a new session.
 */
const sessionPolicy: SessionPolicy = {
	...nativeSessionPolicy,
	planContinuation: () => ({ how: 'fork-native' }),
	toolsChangedAction: () => 'list-changed',
};

export const claudeAdapter: AgentAdapter = {
	id: ID,
	displayName: registry.displayName,
	vendor: vendorOf(ID),
	install: { kind: 'npm', packageName: '@agentclientprotocol/claude-agent-acp', version: '0.94.0', manifestDirectory: 'adapters/claude' },
	launch,
	auth: [
		// Only the start of the command is declared: the agent advertises the rest
		// (`--claudeai`, `--console`) and `terminalMethodsFrom` accepts what begins like this.
		{ kind: 'oauth-browser', label: 'Claude account (browser)', terminalCommand: ['--cli', 'auth', 'login'] },
		{ kind: 'api-key', label: 'Anthropic API key', envVar: 'ANTHROPIC_API_KEY', keyPrefix: 'sk-ant-' },
	],
	settings: [...REGISTRY.commonSettings, ...registry.settings],
	modelPolicy: claudeModelPolicy,
	systemPrompt: {
		toolAccess: 'The tools whose names start with `mcp__vscode__` are VS Code\'s own and act on the user\'s workspace.',
		listRequiredArguments: false,
	},
	usage: claudeUsage,
	sessionPolicy,
	signInCompleted,
	disableBuiltInTools: () => true,
	mergeConfig,
	sessionParams,
	clientCapabilities: {
		// Advertised so the agent lists its terminal sign-in methods; terminal methods themselves stay disabled.
		auth: { terminal: true },
		// Makes the agent report its background commands and tasks, so a chat that
		// still has one running is not released as idle.
		_meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
	},
	modelCallUsage,
};
