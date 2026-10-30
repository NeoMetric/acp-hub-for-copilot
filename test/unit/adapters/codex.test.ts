import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexAdapter, mergeCodexConfig, usageFromRateLimits } from '../../../src/adapters/codex';
import type { AgentSettings, LaunchContext, SessionParamsInput } from '../../../src/core/adapter';

const { readRateLimits } = vi.hoisted(() => ({ readRateLimits: vi.fn() }));
vi.mock('../../../src/adapters/codexRateLimits', () => ({ readRateLimits }));

let storage: string;

beforeEach(() => {
	storage = fs.mkdtempSync(path.join(os.tmpdir(), 'acphub-codex é -'));
	readRateLimits.mockReset();
});

afterEach(() => {
	fs.rmSync(storage, { recursive: true, force: true });
});

function launchContext(settings: AgentSettings = {}, apiKey?: string): LaunchContext {
	return {
		entryPath: path.join(storage, 'node_modules', 'codex-acp', 'dist', 'index.js'),
		installDir: storage,
		storageDir: storage,
		settings,
		apiKey,
		workspaceFolder: path.join(storage, 'Mi Proyecto é'),
	};
}

const sessionInput: SessionParamsInput = { disableBuiltInTools: false, reportEachModelCall: false, isNewSession: true };

describe('codexAdapter', () => {
	it('is described by the registry and installs the pinned npm package', () => {
		expect(codexAdapter.id).toBe('codex');
		expect(codexAdapter.vendor).toBe('acphub-codex');
		expect(codexAdapter.displayName).toBe('Codex Agent');
		expect(codexAdapter.install).toEqual({
			kind: 'npm',
			packageName: '@agentclientprotocol/codex-acp',
			version: '2.3.0',
			manifestDirectory: 'adapters/codex',
		});
		expect(codexAdapter.settings.map(setting => setting.key)).toEqual(['idleTimeoutSeconds', 'idleShutdownMinutes', 'dumpRequests', 'permissionMode', 'authPreference', 'maxContextWindow']);
		expect(codexAdapter.defaultSessionMode).toBe('agent-full-access');
	});

	it('lists its sign-in methods', () => {
		expect(codexAdapter.auth).toEqual([
			{ kind: 'oauth-browser', label: 'ChatGPT account', agentMethodId: 'chat-gpt', browserAuthPreference: 'chatgpt' },
			{ kind: 'api-key', label: 'OpenAI API key', envVar: 'CODEX_API_KEY', keyPrefix: 'sk-' },
		]);
	});

	it('names the chat tools by their mcp__vscode__ prefix and does not list arguments', () => {
		expect(codexAdapter.systemPrompt.toolAccess).toBe('The tools whose names start with `mcp__vscode__` are VS Code\'s own and act on the user\'s workspace.');
		expect(codexAdapter.systemPrompt.listRequiredArguments).toBe(false);
	});
});

describe('codex launch', () => {
	it('runs the adapter entry with node and its own CODEX_HOME', () => {
		const ctx = launchContext();
		const spec = codexAdapter.launch(ctx);

		expect(spec.command).toBe(process.execPath);
		expect(spec.args).toEqual([ctx.entryPath]);
		expect(spec.shell).toBeUndefined();
		expect(spec.env).toEqual({ INITIAL_AGENT_MODE: 'agent-full-access', CODEX_HOME: path.join(storage, 'codex-home') });
		expect(fs.statSync(path.join(storage, 'codex-home')).isDirectory()).toBe(true);
	});

	it('hands the saved key to the agent as CODEX_API_KEY', () => {
		expect(codexAdapter.launch(launchContext({}, 'sk-1')).env.CODEX_API_KEY).toBe('sk-1');
	});

	it('leaves the saved key out when only the ChatGPT account is wanted', () => {
		expect(codexAdapter.launch(launchContext({ authPreference: 'chatgpt' }, 'sk-1')).env.CODEX_API_KEY).toBeUndefined();
	});
});

describe('codex mergeConfig', () => {
	function configOf(env: Record<string, string>, settings: AgentSettings = {}): Record<string, any> {
		const merged = codexAdapter.mergeConfig?.(settings, env);
		return JSON.parse(merged?.CODEX_CONFIG ?? '{}');
	}

	it('turns the built-in tools off and leaves the MCP servers to the agent', () => {
		const config = configOf({});

		expect(config.mcp_servers).toBeUndefined();
		expect(config.features.shell_tool).toBe(false);
		expect(config.features.code_mode).toEqual({ enabled: true, excluded_tool_namespaces: ['functions', 'clock'] });
		expect(config.web_search).toBe('disabled');
		expect(config.model_context_window).toBeUndefined();
	});

	it('keeps what the user already configured', () => {
		const user = JSON.stringify({ model: 'gpt-x', mcp_servers: { other: { command: 'x' }, vscode: { startup_timeout_sec: 5 } }, features: { goals: true, extra: true } });
		const config = configOf({ CODEX_CONFIG: user });

		expect(config.model).toBe('gpt-x');
		expect(config.mcp_servers).toEqual({ other: { command: 'x' }, vscode: { startup_timeout_sec: 5 } });
		expect(config.features.extra).toBe(true);
		expect(config.features.goals).toBe(false);
	});

	it('asks for the largest context window when the setting is on', () => {
		expect(configOf({}, { maxContextWindow: true }).model_context_window).toBe(10_000_000);
	});

	it('refuses a CODEX_CONFIG that is not valid JSON and names it', () => {
		expect(() => codexAdapter.mergeConfig?.({}, { CODEX_CONFIG: '{ not json' })).toThrow('CODEX_CONFIG environment variable is not valid JSON');
		expect(() => mergeCodexConfig('[1]', false)).toThrow('CODEX_CONFIG environment variable is not a JSON object');
		expect(() => mergeCodexConfig('"text"', false)).toThrow('not a JSON object');
	});

	it('withholds the OpenAI key of the shell, and the CODEX key too for the ChatGPT preference', () => {
		const env = { OPENAI_API_KEY: 'sk-shell', CODEX_API_KEY: 'sk-codex', PATH: 'x' };

		const auto = codexAdapter.mergeConfig?.({ authPreference: 'auto' }, env);
		expect(auto?.OPENAI_API_KEY).toBeUndefined();
		expect(auto?.CODEX_API_KEY).toBe('sk-codex');

		const chatgpt = codexAdapter.mergeConfig?.({ authPreference: 'chatgpt' }, env);
		expect(chatgpt?.OPENAI_API_KEY).toBeUndefined();
		expect(chatgpt?.CODEX_API_KEY).toBeUndefined();
		expect(chatgpt?.PATH).toBe('x');
	});

	it('removes the variables of the Claude agent', () => {
		const merged = codexAdapter.mergeConfig?.({}, { ANTHROPIC_API_KEY: 'a', MCP_TOOL_TIMEOUT: '1', CLAUDE_AGENT_LOGS: 'l', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', HOME: 'h' });

		expect(merged?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(merged?.MCP_TOOL_TIMEOUT).toBeUndefined();
		expect(merged?.CLAUDE_AGENT_LOGS).toBeUndefined();
		expect(merged?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
		expect(merged?.HOME).toBe('h');
	});
});

describe('codex hooks', () => {
	it('authenticates with the API key method only when a key is saved', () => {
		expect(codexAdapter.authenticate?.([], 'sk-1')).toEqual({ methodId: 'api-key', _meta: { 'api-key': { apiKey: 'sk-1' } } });
		expect(codexAdapter.authenticate?.([], 'sk-1', { authPreference: 'chatgpt' })).toBeUndefined();
		expect(codexAdapter.authenticate?.([{ id: 'chat-gpt' }], undefined)).toBeUndefined();
	});

	it('sends the system prompt on a new session only', () => {
		const prompt = { systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'guidance' }] } };

		expect(codexAdapter.sessionParams?.({ ...sessionInput, systemPromptAppend: 'guidance' })).toEqual(prompt);
		expect(codexAdapter.sessionParams?.({ ...sessionInput, systemPromptAppend: 'guidance', isNewSession: false })).toEqual({});
		expect(codexAdapter.sessionParams?.(sessionInput)).toEqual({});
	});
});

describe('codex usage', () => {
	const RESET = 1_760_000_000;
	const resetText = new Date(RESET * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

	it('maps both windows, rounded to a tenth, with the reset time', () => {
		const reading = usageFromRateLimits({
			kind: 'limits',
			windows: {
				fiveHour: { usedPercent: 42.449, windowDurationMins: 300, resetsAt: RESET },
				weekly: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: null },
			},
		});

		expect(reading.windows).toEqual([
			{ label: '5-hour', usedPercent: 42.4, resets: resetText },
			{ label: 'Weekly', usedPercent: 7, resets: undefined },
		]);
	});

	it('keeps a single window when the account has only one', () => {
		const reading = usageFromRateLimits({ kind: 'limits', windows: { weekly: { usedPercent: 1.26, windowDurationMins: null, resetsAt: RESET } } });

		expect(reading.windows).toEqual([{ label: 'Weekly', usedPercent: 1.3, resets: resetText }]);
	});

	it('reports an account without plan limits as a note', () => {
		const reading = usageFromRateLimits({ kind: 'no-plan' });

		expect(reading.windows).toEqual([]);
		expect(reading.note).toContain('no ChatGPT plan limits');
	});

	it('throws when the read failed', () => {
		expect(() => usageFromRateLimits({ kind: 'failed', reason: 'the app server stopped' })).toThrow('the app server stopped');
	});

	it('reads the limits of the account the agent runs in', async () => {
		readRateLimits.mockResolvedValue({ kind: 'limits', windows: { fiveHour: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } } });
		const ctx = launchContext();

		const reading = await codexAdapter.usage?.read({ launch: ctx, askAgent: () => Promise.resolve(undefined) }, new AbortController().signal);

		expect(reading?.windows).toEqual([{ label: '5-hour', usedPercent: 10, resets: undefined }]);
		expect(readRateLimits).toHaveBeenCalledWith(ctx.entryPath, expect.objectContaining({ adapterVersion: '2.3.0', codexHome: path.join(storage, 'codex-home') }));
	});

	it('lets a failed read reach the caller as an error', async () => {
		readRateLimits.mockResolvedValue({ kind: 'failed', reason: 'boom' });

		await expect(codexAdapter.usage?.read({ launch: launchContext(), askAgent: () => Promise.resolve(undefined) }, new AbortController().signal)).rejects.toThrow('boom');
	});
});
