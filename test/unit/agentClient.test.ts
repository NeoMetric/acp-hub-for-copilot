/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentSettings, LaunchContext } from '../../src/core/adapter';
import { AdapterNotInstalledError, AgentClient, readTokenUsage, type AgentChange } from '../../src/core/agentClient';
import type { Log } from '../../src/core/logging';
import { isAuthRequiredError, RpcConnectionClosedError, RpcError } from '../../src/core/rpc';

const MOCK_AGENT = path.resolve(__dirname, '..', 'fixtures', 'mock-acp-agent.cjs');

let temp: string;
let client: AgentClient | undefined;
/** The mode the next started process runs in; a test changes it between starts. */
let mockMode: string;
let log: Log;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-client-'));
	mockMode = 'normal';
	log = () => { };
});

afterEach(() => {
	client?.dispose();
	client = undefined;
	vi.useRealTimers();
	// A killed agent can hold its working directory for a moment on Windows.
	fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function testAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
	return {
		id: 'test',
		displayName: 'Test',
		vendor: 'acphub-test',
		install: { kind: 'existing-cli', command: 'mock' },
		launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: mockMode } }),
		auth: [],
		settings: [],
		// The client never reads the model policy.
		modelPolicy: {} as AgentAdapter['modelPolicy'],
		systemPrompt: { toolAccess: 'The tools of the test server are the chat\'s own.', listRequiredArguments: false },
		...overrides,
	};
}

function launchContext(settings: AgentSettings = {}, entryPath = MOCK_AGENT): LaunchContext {
	return { entryPath, installDir: temp, storageDir: temp, settings, workspaceFolder: temp };
}

function createClient(adapter: AgentAdapter = testAdapter(), ctx: LaunchContext = launchContext(), askPermission?: (message: string, labels: string[]) => Promise<number | undefined>): AgentClient {
	client = new AgentClient(adapter, ctx, { log, storageDir: temp, clientVersion: '0.0.0', askPermission });
	return client;
}

async function reply(target: AgentClient, sessionId: string, text: string): Promise<string> {
	let reply = '';
	await target.prompt(sessionId, [{ type: 'text', text }], { onText: chunk => { reply += chunk; } });
	return reply;
}

describe('AgentClient', () => {
	it('starts the agent, opens a session and streams a turn', async () => {
		const target = createClient();
		const session = await target.createSession({ cwd: temp, mcpServers: [] });
		const chunks: string[] = [];

		const result = await target.prompt(session.sessionId, [{ type: 'text', text: 'hi' }], { onText: text => chunks.push(text) });

		expect(session.configOptions.map(option => option.id)).toEqual(['model', 'effort']);
		expect(chunks).toEqual(['hello']);
		expect(result.stopReason).toBe('end_turn');
		expect(result.usage?.inputTokens).toBe(3);
		expect(result.usage?.outputTokens).toBe(2);
		expect(target.availableAuthMethods.map(method => method.id)).toEqual(['mock-login']);
	});

	it('surfaces an authentication-required error and remembers that sign-in is needed', async () => {
		mockMode = 'auth-required';
		const target = createClient();

		const failure = await target.createSession({ cwd: temp, mcpServers: [] }).catch(error => error);

		expect(isAuthRequiredError(failure)).toBe(true);
		expect(target.requiresSignIn).toBe(true);
	});

	it('fails the request when the process dies mid-request, then restarts on the next one', async () => {
		mockMode = 'crash-mid-request';
		const target = createClient();
		const changes: AgentChange[] = [];
		target.onDidChange(change => changes.push(change));
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		const failure = await reply(target, session.sessionId, 'hi').catch(error => error);

		expect(failure).toBeInstanceOf(RpcConnectionClosedError);
		await vi.waitFor(() => expect(changes).toContain('exited'));

		mockMode = 'normal';
		const next = await target.createSession({ cwd: temp, mcpServers: [] });
		expect(await reply(target, next.sessionId, 'hi')).toBe('hello');
	});

	it('ignores a stdout line that is not JSON', async () => {
		mockMode = 'garbage';
		const target = createClient();
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		expect(await reply(target, session.sessionId, 'hi')).toBe('hello');
	});

	it('cancels a running turn', async () => {
		mockMode = 'slow';
		const target = createClient();
		const session = await target.createSession({ cwd: temp, mcpServers: [] });
		const chunks: string[] = [];

		const turn = target.prompt(session.sessionId, [{ type: 'text', text: 'hi' }], { onText: text => chunks.push(text) });
		await vi.waitFor(() => expect(chunks).toEqual(['working']));
		target.cancel(session.sessionId);

		expect((await turn).stopReason).toBe('cancelled');
	});

	it('stops the process after idleShutdownMinutes without use, and starts it again on the next request', async () => {
		const target = createClient(testAdapter(), launchContext({ idleShutdownMinutes: 1 }));
		const changes: AgentChange[] = [];
		target.onDidChange(change => changes.push(change));
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		expect(await reply(target, session.sessionId, 'hi')).toBe('hello');
		expect(target.isRunning).toBe(true);

		await vi.advanceTimersByTimeAsync(59_000);
		expect(target.isRunning).toBe(true);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(target.isRunning).toBe(false);
		vi.useRealTimers();
		await vi.waitFor(() => expect(changes).toContain('idle'));

		const next = await target.createSession({ cwd: temp, mcpServers: [] });
		expect(await reply(target, next.sessionId, 'hi')).toBe('hello');
	});

	it('never stops an idle process when idleShutdownMinutes is 0', async () => {
		const target = createClient(testAdapter(), launchContext({ idleShutdownMinutes: 0 }));
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		await reply(target, session.sessionId, 'hi');
		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

		expect(target.isRunning).toBe(true);
	});

	it('throws AdapterNotInstalledError when there is nothing to launch', async () => {
		const target = createClient(testAdapter(), launchContext({}, ''));

		const failure = await target.createSession({ cwd: temp, mcpServers: [] }).catch(error => error);

		expect(failure).toBeInstanceOf(AdapterNotInstalledError);
		expect(failure.message).toContain('ACP Hub sidebar');
		expect(target.isRunning).toBe(false);
	});

	it('reports a session the agent no longer has instead of creating one', async () => {
		const target = createClient();
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		const failure = await reply(target, session.sessionId, 'forget').catch(error => error);

		expect(failure).toBeInstanceOf(RpcError);
		expect((failure as RpcError).code).toBe(-32602);
		expect(await reply(target, 'unknown-session', 'hi').catch(error => error)).toBeInstanceOf(RpcError);
		expect(await reply(target, session.sessionId, 'count')).toBe('new:1');
	});

	it('resumes a stored session under its own id', async () => {
		const target = createClient();

		const session = await target.resumeSession('stored-1', { cwd: temp, mcpServers: [] });

		expect(session.sessionId).toBe('stored-1');
		expect(await reply(target, 'stored-1', 'hi')).toBe('hello');
	});

	it('lets the adapter turn an error into its own', async () => {
		class LimitError extends Error { }
		const adapter = testAdapter({ mapError: error => error instanceof RpcError && error.code === -32602 ? new LimitError('limit reached') : undefined });
		const target = createClient(adapter);
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		const failure = await reply(target, session.sessionId, 'forget').catch(error => error);

		expect(failure).toBeInstanceOf(LimitError);
	});

	it('starts the process with the adapter environment, and lets mergeConfig change it', async () => {
		const adapter = testAdapter({
			launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: 'normal', FROM_ADAPTER: 'one', REMOVED: 'x' } }),
			mergeConfig: (settings, env) => {
				const merged: Record<string, string> = { ...env, MERGED: String(settings.flavor) };
				delete merged.REMOVED;
				return merged;
			},
		});
		const target = createClient(adapter, launchContext({ flavor: 'mint' }));
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		expect(await reply(target, session.sessionId, 'env:FROM_ADAPTER')).toBe('one');
		expect(await reply(target, session.sessionId, 'env:MERGED')).toBe('mint');
		expect(await reply(target, session.sessionId, 'env:REMOVED')).toBe('unset');
	});

	it('passes the adapter session parameters and the built-in-tools decision to the hook', async () => {
		const sessionParams = vi.fn(() => ({}));
		const adapter = testAdapter({ disableBuiltInTools: settings => settings.own === true, sessionParams });
		const target = createClient(adapter, launchContext({ own: true }));

		await target.createSession({ cwd: temp, mcpServers: [], systemPromptAppend: 'be brief', model: 'mock-2' });

		expect(sessionParams).toHaveBeenCalledWith({
			systemPromptAppend: 'be brief',
			model: 'mock-2',
			disableBuiltInTools: true,
			reportEachModelCall: false,
			isNewSession: true,
		});
	});

	it('approves permission requests by itself in auto mode', async () => {
		const target = createClient(testAdapter(), launchContext({ permissionMode: 'auto' }));
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		expect(await reply(target, session.sessionId, 'permission')).toContain('allow_once');
	});

	it('asks the user in ask mode and declines when dismissed', async () => {
		const ask = vi.fn(async () => undefined);
		const target = createClient(testAdapter(), launchContext({ permissionMode: 'ask' }), ask);
		const session = await target.createSession({ cwd: temp, mcpServers: [] });

		const text = await reply(target, session.sessionId, 'permission');

		expect(ask).toHaveBeenCalledWith(expect.stringContaining('Write a.txt'), ['Allow', 'Reject']);
		expect(text).toContain('cancelled');
	});

	it('restarts a running agent when the launch context changes', async () => {
		const target = createClient();
		const changes: AgentChange[] = [];
		target.onDidChange(change => changes.push(change));
		await target.createSession({ cwd: temp, mcpServers: [] });

		await target.updateContext(launchContext({ permissionMode: 'ask' }));

		expect(changes).toEqual(['restarted']);
		expect(target.isRunning).toBe(false);
	});
});

describe('readTokenUsage', () => {
	it('prefers the quota breakdown and names its cache fields', () => {
		const usage = readTokenUsage({
			usage: { inputTokens: 1, outputTokens: 1 },
			_meta: { quota: { token_count: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, cacheWriteInputTokens: 2 } } },
		});

		expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 4, cachedWriteTokens: 2, totalTokens: 21, reasoningOutputTokens: undefined });
	});

	it('reads the standard usage field and ignores negative counts', () => {
		const usage = readTokenUsage({ usage: { inputTokens: 7, outputTokens: -3, cachedReadTokens: 2 } });

		expect(usage?.outputTokens).toBe(0);
		expect(usage?.totalTokens).toBe(9);
	});

	it('returns undefined without any usage', () => {
		expect(readTokenUsage({ stopReason: 'end_turn' })).toBeUndefined();
	});
});
