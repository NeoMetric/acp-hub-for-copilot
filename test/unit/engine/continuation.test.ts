/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../../src/core/adapter';
import { AgentClient } from '../../../src/engine/acp/agentClient';
import { ChatService } from '../../../src/engine/chat/ChatService';
import type { AgentProcesses } from '../../../src/engine/chat/agentProcess';
import type { ChatMessage, ChatRequest, ToolDef } from '../../../src/engine/model/chat';
import type { StreamEvent } from '../../../src/engine/model/stream';
import type { HostPort } from '../../../src/engine/ports/host';

const MOCK_AGENT = path.resolve(__dirname, '..', '..', 'fixtures', 'mock-acp-agent.cjs');

const adapter: AgentAdapter = {
	id: 'mock',
	displayName: 'Mock',
	vendor: 'acphub-mock',
	install: { kind: 'existing-cli', command: 'node' },
	launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: {} }),
	auth: [],
	settings: [],
	modelPolicy: {} as AgentAdapter['modelPolicy'],
	systemPrompt: { toolAccess: '', listRequiredArguments: false },
};

/** A tool the host offers, which a chat needs for its session to be reusable. */
const tool: ToolDef = { name: 'read', description: 'read a file', inputSchema: { type: 'object' } };

function memoryState() {
	const values = new Map<string, unknown>();
	return {
		values,
		get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
		update: (key: string, value: unknown): Promise<void> => { values.set(key, value); return Promise.resolve(); },
		keys: (): readonly string[] => [...values.keys()],
	};
}

/** A host that runs nowhere: it keeps the chat's state in memory and writes down what the service logs. */
function fakeHost(state: ReturnType<typeof memoryState>, logs: string[]): HostPort {
	return {
		log: (message: string) => { logs.push(message); },
		state,
		secrets: {
			get: () => Promise.resolve(undefined),
			set: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		},
		settings: { get: () => undefined },
		storageRoot: '',
		chatIdentity: request => ({ id: request.chatId, cwd: process.cwd(), workspaceFolders: [] }),
		guidanceOf: () => undefined,
		stripHostSections: text => text,
		chatWideContextOf: () => undefined,
		executeTool: () => Promise.resolve({ content: [] }),
		ui: {
			requestSignIn: () => undefined,
			notify: () => Promise.resolve(undefined),
			openExternal: () => Promise.resolve(),
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];

/** A service over the mock ACP agent, which behaves as `MOCK_ACP_MODE` says. */
function service(mode: string, logs: string[] = []) {
	const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-continuation-'));
	const state = memoryState();
	const chat = new ChatService({
		adapter: { ...adapter, launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: mode } }) },
		host: fakeHost(state, logs),
		bridge: {
			registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
			updateTools: () => undefined,
			unregisterSession: () => undefined,
		},
		resolveLaunch: () => Promise.resolve({ entryPath: MOCK_AGENT, installDir: '', storageDir, workspaceFolder: process.cwd(), settings: {} }),
	});
	cleanups.push(async () => {
		await chat.close();
		// The agent ran in the store, and a process keeps the folder it runs in until it is gone.
		try {
			fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch {
			// Left to the temp folder's own clean-up.
		}
	});

	/** Sends a chat of the given user turns, as the host does, and returns the text the agent replied with. */
	async function send(chatId: string, texts: readonly string[]): Promise<string> {
		const messages: ChatMessage[] = [];
		for (const [index, text] of texts.entries()) {
			if (index > 0) {
				messages.push({ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] });
			}
			messages.push({ role: 'user', parts: [{ type: 'text', text }] });
		}
		const request: ChatRequest = { chatId, cwd: process.cwd(), messages, tools: [tool], model: 'mock-model' };
		const events: StreamEvent[] = [];
		await chat.respond(request, event => events.push(event), new AbortController().signal);
		return events.flatMap(event => (event.type === 'text' ? [event.text] : [])).join('');
	}

	return { chat, state, logs, send };
}

/** The conversations the service stored, as the shared state holds them. */
function saved(state: ReturnType<typeof memoryState>) {
	return state.get<Array<{ key: string; sessionId: string; checkpoints?: unknown[] }>>('acpHub.savedSessions.mock') ?? [];
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
	vi.restoreAllMocks();
});

describe('continuing a stored conversation', () => {
	it('records a checkpoint at the end of a turn, and forks the turn an edit still agrees with', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const fork = vi.spyOn(AgentClient.prototype, 'forkSession');
		const { logs, send, state } = service('fork');

		await send('chat-fork', ['hi']);
		await send('chat-fork', ['hi', 'second']);

		const [stored] = saved(state);
		expect(stored.checkpoints?.length ?? 0, 'a checkpoint after each turn').toBeGreaterThanOrEqual(2);

		// The second turn is rewritten: the first one still agrees, so the chat forks after it.
		await send('chat-fork', ['hi', 'meta']);

		expect(fork, 'the agent was asked to fork').toHaveBeenCalledTimes(1);
		expect(fork.mock.calls[0][2], 'the fork point is the checkpoint of the first turn').toMatchObject({ messageFingerprint: expect.any(String) });
		expect(created, 'the chat kept its session instead of opening another').toHaveBeenCalledTimes(1);
		expect(logs.some(line => line.includes('was edited; forking from the checkpoint after 2 message(s)'))).toBe(true);
		expect(saved(state)[0].sessionId, 'the chat continues in the forked session').not.toBe(stored.sessionId);
	});

	it('starts a new session with the transcript when the agent does not advertise forking', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const fork = vi.spyOn(AgentClient.prototype, 'forkSession');
		const { logs, send } = service('normal');

		await send('chat-edit', ['hi']);
		await send('chat-edit', ['hi', 'second']);
		await send('chat-edit', ['hi', 'third']);

		expect(fork, 'an agent without forking is never asked').not.toHaveBeenCalled();
		expect(created, 'the rewritten chat got a session of its own').toHaveBeenCalledTimes(2);
		expect(logs.some(line => line.includes('was edited and has no checkpoint to fork from'))).toBe(true);
	});

	it('keeps the session of a chat that comes back unchanged', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const fork = vi.spyOn(AgentClient.prototype, 'forkSession');
		const { send } = service('normal');

		await send('chat-same', ['hi']);
		await send('chat-same', ['hi', 'second']);

		expect(created).toHaveBeenCalledTimes(1);
		expect(fork).not.toHaveBeenCalled();
	});
});

describe('starting an agent again that the idle shutdown stopped', () => {
	it('starts the agent and its warm session when the user is back, once per idle stop', async () => {
		const logs: string[] = [];
		const { chat, send } = service('normal', logs);
		await send('chat-idle', ['hi']);

		const processes = (chat as unknown as { processes: AgentProcesses }).processes;
		const client = processes.current?.client;
		expect(client, 'the chat opened its agent').toBeDefined();
		await client!.stopWhenIdle();
		expect(logs.some(line => line.includes('Nothing has used the Mock agent'))).toBe(true);

		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		chat.wakeAfterIdle();
		await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
		expect(logs.some(line => line.includes('starting the Mock agent it stopped for being idle'))).toBe(true);

		chat.wakeAfterIdle();
		await Promise.resolve();
		expect(created, 'the agent is started once per idle stop').toHaveBeenCalledTimes(1);
	});

	it('leaves alone an agent that was never stopped', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const { chat } = service('normal');

		chat.wakeAfterIdle();
		await Promise.resolve();

		expect(created).not.toHaveBeenCalled();
	});
});
