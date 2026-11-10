/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, LaunchContext } from '../../../src/core/adapter';
import type { AgentSession, PromptHandlers } from '../../../src/engine/acp/agentClient';
import { ChatService } from '../../../src/engine/chat/ChatService';
import { MAX_CHAT_SESSIONS } from '../../../src/engine/chat/idle';
import type { AgentApi } from '../../../src/engine/chat/types';
import type { ChatMessage, ChatRequest, ToolResult } from '../../../src/engine/model/chat';
import type { HostPort } from '../../../src/engine/ports/host';

/** A store of the test's own, so the agent process runs in a folder of its own. */
const storeDir = path.join(os.tmpdir(), `acp-hub-session-owners-${process.pid}`);

afterEach(() => {
	try {
		fs.rmSync(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		// Left to the temp folder's own clean-up.
	}
});

const adapter: AgentAdapter = {
	id: 'mock',
	displayName: 'Mock',
	vendor: 'acphub-mock',
	install: { kind: 'existing-cli', command: 'node' },
	launch: () => ({ command: 'node', args: [], env: {} }),
	auth: [],
	settings: [],
	modelPolicy: {} as AgentAdapter['modelPolicy'],
	systemPrompt: { toolAccess: '', listRequiredArguments: false },
};

/** One agent process: a session per chat, and the ids it was told to close. */
class FakeAgent {
	readonly sessions: string[] = [];
	readonly prompts: string[] = [];
	readonly closed: string[] = [];
	private count = 0;
	supportsFork = false;
	supportsDelete = false;
	isRunning = true;
	requiresSignIn = false;
	dispose = (): void => undefined;
	onDidChange = (): { dispose(): void } => ({ dispose() { } });
	updateContext = vi.fn(async (): Promise<void> => undefined);
	ensureStarted = vi.fn(async (): Promise<void> => undefined);
	restart = vi.fn(async (): Promise<void> => undefined);
	stopWhenIdle = vi.fn(async (): Promise<void> => undefined);
	signInWithMethod = vi.fn(async (): Promise<void> => undefined);
	setConfigOption = vi.fn(async (): Promise<void> => undefined);
	setSessionModel = vi.fn(async (): Promise<void> => undefined);
	hasBackgroundTasks = (): boolean => false;
	cancel = vi.fn();
	createSession = async (): Promise<AgentSession> => {
		const sessionId = `s${++this.count}`;
		this.sessions.push(sessionId);
		return { sessionId, configOptions: [] };
	};
	resumeSession = async (sessionId: string): Promise<AgentSession> => ({ sessionId, configOptions: [] });
	forkSession = async (): Promise<AgentSession> => this.createSession();
	deleteSession = async (): Promise<boolean> => false;
	closeSession = vi.fn(async (sessionId: string): Promise<void> => { this.closed.push(sessionId); });
	prompt = async (sessionId: string, _blocks: unknown, handlers: PromptHandlers): Promise<{ stopReason: string }> => {
		this.prompts.push(sessionId);
		// A real agent answers over a pipe, so the turn exists before its first event arrives.
		await Promise.resolve();
		handlers.onText('hello');
		return { stopReason: 'end_turn' };
	};
}

function memoryState() {
	const values = new Map<string, unknown>();
	return {
		get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
		update: (key: string, value: unknown): Promise<void> => { values.set(key, value); return Promise.resolve(); },
		keys: (): readonly string[] => [...values.keys()],
	};
}

/** A host with two clients: chats whose id starts with "b" belong to B, the rest to A. */
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
		chatIdentity: request => ({
			id: request.chatId,
			cwd: request.cwd,
			workspaceFolders: [],
			owner: request.chatId.startsWith('b') ? 'owner-b' : 'owner-a',
		}),
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

const request = (chatId: string, turns = 1): ChatRequest => {
	const messages: ChatMessage[] = [];
	for (let index = 1; index <= turns; index++) {
		messages.push({ role: 'user', parts: [{ type: 'text', text: index === 1 ? `hello from ${chatId}` : `again ${index}` }] });
		if (index < turns) {
			messages.push({ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] });
		}
	}
	return { chatId, cwd: '/repo', messages, tools: [], model: 'mock-model' };
};

function service() {
	const agent = new FakeAgent();
	const launch: LaunchContext = { entryPath: 'fake', installDir: '', storageDir: storeDir, settings: {}, workspaceFolder: '/repo' };
	const chat = new ChatService({
		adapter,
		host: fakeHost(),
		bridge: {
			registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
			updateTools: () => undefined,
			unregisterSession: () => undefined,
		},
		resolveLaunch: () => Promise.resolve(launch),
		createClient: () => agent as unknown as AgentApi,
	});
	return { chat, agent };
}

const respond = (chat: ChatService, chatId: string, turns = 1): Promise<void> =>
	chat.respond(request(chatId, turns), () => undefined, new AbortController().signal);

describe('the sessions an owner may keep', () => {
	it('closes the least recently used sessions of one owner and leaves another owner alone', async () => {
		const { chat, agent } = service();
		try {
			await respond(chat, 'b1');
			const bSession = agent.sessions[0];

			for (let index = 1; index <= MAX_CHAT_SESSIONS + 2; index++) {
				await respond(chat, `a${index}`);
			}

			// The two oldest chats of A made room for the newest two; B was never a candidate.
			expect(agent.sessions).toHaveLength(MAX_CHAT_SESSIONS + 3);
			expect(agent.closed).toEqual([agent.sessions[1], agent.sessions[2]]);
			expect(chat.openSessions).toBe(MAX_CHAT_SESSIONS + 1);

			await respond(chat, 'b1', 2);
			expect(agent.sessions).toHaveLength(MAX_CHAT_SESSIONS + 3);
			expect(agent.prompts.at(-1)).toBe(bSession);
		} finally {
			await chat.close();
		}
	});
});
