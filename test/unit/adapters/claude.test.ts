import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter, modelCallUsageOf } from '../../../src/adapters/claude';
import { claudeUsage } from '../../../src/adapters/claudeUsage';
import type { AgentSettings, LaunchContext, SessionParamsInput } from '../../../src/core/adapter';

const STORAGE = path.join('C:', 'Users', 'Zoë Müller', 'storage', 'claude');

function launchContext(settings: AgentSettings = {}, apiKey?: string): LaunchContext {
	return {
		entryPath: path.join('C:', 'Users', 'Zoë Müller', 'storage', 'claude', 'node_modules', 'claude-agent-acp', 'dist', 'index.js'),
		installDir: STORAGE,
		storageDir: STORAGE,
		settings,
		apiKey,
		workspaceFolder: path.join('C:', 'My Projects', 'é'),
	};
}

const sessionInput: SessionParamsInput = { disableBuiltInTools: true, reportEachModelCall: false, isNewSession: true };

describe('claudeAdapter', () => {
	it('is described by the registry and installs the pinned npm package', () => {
		expect(claudeAdapter.id).toBe('claude');
		expect(claudeAdapter.vendor).toBe('acphub-claude');
		expect(claudeAdapter.displayName).toBe('Claude Agent');
		expect(claudeAdapter.install).toEqual({
			kind: 'npm',
			packageName: '@agentclientprotocol/claude-agent-acp',
			version: '0.94.0',
			manifestDirectory: 'adapters/claude',
		});
		expect(claudeAdapter.usage).toBe(claudeUsage);
		expect(claudeAdapter.settings.map(setting => setting.key)).toEqual(['idleTimeoutSeconds', 'idleShutdownMinutes', 'dumpRequests', 'permissionMode', 'authPreference']);
	});

	it('lists its sign-in methods', () => {
		expect(claudeAdapter.auth).toEqual([
			{ kind: 'oauth-browser', label: 'Claude account (browser)', terminalCommand: ['--cli', 'auth', 'login'] },
			{ kind: 'api-key', label: 'Anthropic API key', envVar: 'ANTHROPIC_API_KEY', keyPrefix: 'sk-ant-' },
		]);
	});

	it('names the chat tools by their mcp__vscode__ prefix and does not list arguments', () => {
		expect(claudeAdapter.systemPrompt.toolAccess).toBe('The tools whose names start with `mcp__vscode__` are VS Code\'s own and act on the user\'s workspace.');
		expect(claudeAdapter.systemPrompt.listRequiredArguments).toBe(false);
	});

	it('advertises terminal sign-in and background tasks', () => {
		expect(claudeAdapter.clientCapabilities).toEqual({
			auth: { terminal: true },
			_meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
		});
	});
});

describe('claude launch', () => {
	it('runs the adapter entry with node, in a path with spaces and é', () => {
		const ctx = launchContext();
		const spec = claudeAdapter.launch(ctx);

		expect(spec.command).toBe(process.execPath);
		expect(spec.args).toEqual([ctx.entryPath]);
		expect(spec.shell).toBeUndefined();
		expect(spec.env).toEqual({
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
			CLAUDE_AGENT_LOGS: path.join(STORAGE, 'logs'),
		});
	});

	it('hands the saved key to the agent', () => {
		expect(claudeAdapter.launch(launchContext({}, 'sk-ant-1')).env.ANTHROPIC_API_KEY).toBe('sk-ant-1');
		expect(claudeAdapter.launch(launchContext({ authPreference: 'apiKey' }, 'sk-ant-1')).env.ANTHROPIC_API_KEY).toBe('sk-ant-1');
	});

	it('leaves the saved key out when only the signed-in account is wanted', () => {
		expect(claudeAdapter.launch(launchContext({ authPreference: 'oauth' }, 'sk-ant-1')).env.ANTHROPIC_API_KEY).toBeUndefined();
	});
});

describe('claude mergeConfig', () => {
	it('adds the tool timeouts and keeps values the user set', () => {
		const merged = claudeAdapter.mergeConfig?.({}, { PATH: 'x', MCP_TOOL_TIMEOUT: '5000' });

		expect(merged?.MCP_TOOL_TIMEOUT).toBe('5000');
		expect(merged?.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe(String(24 * 60 * 60_000));
		expect(merged?.PATH).toBe('x');
	});

	it('removes a key of the shell when only the signed-in account is wanted', () => {
		const env = { ANTHROPIC_API_KEY: 'sk-ant-shell' };

		expect(claudeAdapter.mergeConfig?.({ authPreference: 'oauth' }, env).ANTHROPIC_API_KEY).toBeUndefined();
		expect(claudeAdapter.mergeConfig?.({ authPreference: 'auto' }, env).ANTHROPIC_API_KEY).toBe('sk-ant-shell');
	});
});

describe('claude sessionParams', () => {
	it('turns every built-in tool off and carries the system prompt', () => {
		const params = claudeAdapter.sessionParams?.({ ...sessionInput, systemPromptAppend: 'guidance', model: 'claude-x' });

		expect(params).toEqual({
			_meta: {
				disableBuiltInTools: true,
				systemPrompt: { append: 'guidance' },
				claudeCode: {
					options: {
						tools: [],
						allowedTools: ['mcp__vscode__*'],
						strictMcpConfig: true,
						settingSources: [],
						model: 'claude-x',
					},
				},
			},
		});
		expect(claudeAdapter.disableBuiltInTools?.({})).toBe(true);
	});

	it('asks for each model call only when the client wants them', () => {
		const withCalls = claudeAdapter.sessionParams?.({ ...sessionInput, reportEachModelCall: true }) as { _meta: { claudeCode: Record<string, unknown> } };
		const without = claudeAdapter.sessionParams?.(sessionInput) as { _meta: { claudeCode: Record<string, unknown>; systemPrompt?: unknown } };

		expect(withCalls._meta.claudeCode.emitRawSDKMessages).toEqual([{ type: 'assistant' }]);
		expect(without._meta.claudeCode.emitRawSDKMessages).toBeUndefined();
		expect(without._meta.systemPrompt).toBeUndefined();
	});
});

describe('claude modelCallUsage', () => {
	const call = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { role: 'assistant', usage }, ...extra });

	it('reads the usage of one model call', () => {
		expect(modelCallUsageOf(call({
			input_tokens: 3,
			output_tokens: 20,
			cache_read_input_tokens: 900,
			cache_creation_input_tokens: 40,
			output_tokens_details: { thinking_tokens: 7 },
		}))).toMatchObject({
			inputTokens: 3,
			outputTokens: 20,
			cachedReadTokens: 900,
			cachedWriteTokens: 40,
			totalTokens: 963,
			reasoningOutputTokens: 7,
		});
	});

	it('ignores messages that carry no usage, and the calls of a subagent', () => {
		expect(modelCallUsageOf({ type: 'assistant' })).toBeUndefined();
		expect(modelCallUsageOf(undefined)).toBeUndefined();
		expect(modelCallUsageOf({ type: 'user', message: { usage: { input_tokens: 5 } } })).toBeUndefined();
		expect(modelCallUsageOf(call({ input_tokens: 5 }, { parent_tool_use_id: 'toolu_1' }))).toBeUndefined();
		expect(modelCallUsageOf(call({ input_tokens: 0, output_tokens: 0 }))).toBeUndefined();
	});

	it('counts a model call once however many content blocks repeat its usage', () => {
		const seen = new Set<string>();
		const block = { type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 3, cache_read_input_tokens: 900 } } };
		expect(modelCallUsageOf(block, seen)).toMatchObject({ inputTokens: 3, cachedReadTokens: 900 });
		expect(modelCallUsageOf(block, seen)).toBeUndefined();
		expect(modelCallUsageOf({ ...block, message: { ...block.message, id: 'msg_2' } }, seen)).toBeDefined();
	});

	it('answers only the _claude/sdkMessage notification, with the session it belongs to', () => {
		const seen = new Set<string>();
		const params = { sessionId: 's1', message: call({ input_tokens: 4 }) };

		expect(claudeAdapter.modelCallUsage?.('session/update', params, seen)).toBeUndefined();
		expect(claudeAdapter.modelCallUsage?.('_claude/sdkMessage', params, seen)).toMatchObject({ sessionId: 's1', usage: { inputTokens: 4 } });
		expect(claudeAdapter.modelCallUsage?.('_claude/sdkMessage', { sessionId: 's1', message: { type: 'user' } }, seen)).toEqual({ sessionId: 's1', usage: undefined });
	});
});

describe('claude usage', () => {
	it('reads the 5-hour and weekly windows from the /usage reply', async () => {
		const markdown = [
			'> Claude Max 5x subscription usage',
			'',
			'**5-hour limit** — **42%** · Resets Oct 20, 6:30 PM GMT+5:30',
			'**Weekly · All models** — **17.5%** · Resets Oct 24, 9:00 AM GMT+5:30',
			'',
		].join('\n');
		const reading = await claudeAdapter.usage?.read({ launch: launchContext(), askAgent: () => Promise.resolve(markdown) }, new AbortController().signal);

		expect(reading?.windows.map(window => [window.label, window.usedPercent])).toEqual([['5-hour', 42], ['Weekly', 17.5]]);
	});
});
