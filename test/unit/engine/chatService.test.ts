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
import { ChatService, type ChatServiceDeps } from '../../../src/engine/chat/ChatService';
import type { ChatMessage, ChatRequest, ToolResult } from '../../../src/engine/model/chat';
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

function memoryState() {
	const values = new Map<string, unknown>();
	return {
		get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
		update: (key: string, value: unknown): Promise<void> => { values.set(key, value); return Promise.resolve(); },
		keys: (): readonly string[] => [...values.keys()],
	};
}

/** A host that runs nowhere: it names the chat and leaves the tools to the caller. */
function fakeHost(): HostPort {
	return {
		log: () => undefined,
		state: memoryState(),
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
		executeTool: (): Promise<ToolResult> => Promise.resolve({ content: [] }),
		ui: {
			requestSignIn: () => undefined,
			notify: () => Promise.resolve(undefined),
			openExternal: () => Promise.resolve(),
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];

/** A service over the mock ACP agent, which behaves as `MOCK_ACP_MODE` says. */
function service(mode = 'normal', deps: Partial<ChatServiceDeps> = {}): ChatService {
	const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-engine-'));
	const created = new ChatService({
		adapter: { ...adapter, launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: mode } }) },
		host: fakeHost(),
		bridge: {
			registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
			updateTools: () => undefined,
			unregisterSession: () => undefined,
		},
		resolveLaunch: () => Promise.resolve({ entryPath: MOCK_AGENT, installDir: '', storageDir, workspaceFolder: process.cwd(), settings: {} }),
		...deps,
	});
	cleanups.push(async () => {
		await created.close();
		fs.rmSync(storageDir, { recursive: true, force: true });
	});
	return created;
}

const request = (chatId: string, text = 'hi', turns = 1): ChatRequest => {
	const messages: ChatMessage[] = [];
	for (let index = 1; index <= turns; index++) {
		messages.push({ role: 'user', parts: [{ type: 'text', text: index === 1 ? text : `${text} ${index}` }] });
		if (index < turns) {
			messages.push({ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] });
		}
	}
	return { chatId, cwd: process.cwd(), messages, tools: [], model: 'mock-model' };
};

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
	vi.restoreAllMocks();
});

describe('ChatService', () => {
	it('streams a turn as text and then finishes it', async () => {
		const chat = service();
		const events: StreamEvent[] = [];

		await chat.respond(request('chat-1'), event => events.push(event), new AbortController().signal);

		expect(events[0]).toEqual({ type: 'text', text: 'hello' });
		expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
		expect(events.some(event => event.type === 'error')).toBe(false);
	});

	it('continues the same agent session when the chat comes back', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const chat = service();

		await chat.respond(request('chat-2'), () => undefined, new AbortController().signal);
		await chat.respond(request('chat-2', 'hi', 2), () => undefined, new AbortController().signal);

		expect(created).toHaveBeenCalledTimes(1);
	});

	it('gives every chat its own session', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const chat = service();

		await chat.respond(request('chat-a'), () => undefined, new AbortController().signal);
		await chat.respond(request('chat-b'), () => undefined, new AbortController().signal);

		expect(created).toHaveBeenCalledTimes(2);
	});

	it('closes during a request without leaving a rejection behind', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
		process.on('unhandledRejection', onUnhandled);
		try {
			const chat = service('slow');
			const events: StreamEvent[] = [];
			const running = chat.respond(request('chat-3'), event => events.push(event), new AbortController().signal);

			while (events.length === 0) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			await chat.close();
			await running;
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('reports the usage it counted', async () => {
		const chat = service();

		await chat.respond(request('chat-4'), () => undefined, new AbortController().signal);

		expect(chat.usage()).toMatchObject({ calls: expect.any(Number) });
	});

	it('does not start an agent the host disabled', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const chat = service('normal', { isEnabled: () => false });

		await expect(chat.respond(request('chat-off'), () => undefined, new AbortController().signal))
			.rejects.toThrow('enable it from the ACP Hub sidebar');

		expect(created).not.toHaveBeenCalled();
	});

	it('starts the agent again once the host enables it, without a restart', async () => {
		const created = vi.spyOn(AgentClient.prototype, 'createSession');
		const enabled = { value: false };
		const chat = service('normal', { isEnabled: () => enabled.value });
		await expect(chat.respond(request('chat-later'), () => undefined, new AbortController().signal)).rejects.toThrow(/disabled/);

		enabled.value = true;
		const events: StreamEvent[] = [];
		await chat.respond(request('chat-later'), event => events.push(event), new AbortController().signal);

		expect(created).toHaveBeenCalledTimes(1);
		expect(events.some(event => event.type === 'text')).toBe(true);
	});
});
