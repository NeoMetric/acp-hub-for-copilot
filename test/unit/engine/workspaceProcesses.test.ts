/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, LaunchContext } from '../../../src/core/adapter';
import type { AgentSession, PromptHandlers } from '../../../src/engine/acp/agentClient';
import { ChatService } from '../../../src/engine/chat/ChatService';
import type { AgentApi } from '../../../src/engine/chat/types';
import type { ChatMessage, ChatRequest, ToolResult } from '../../../src/engine/model/chat';
import type { StreamEvent } from '../../../src/engine/model/stream';
import type { HostPort } from '../../../src/engine/ports/host';

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

/** One agent process: a session per chat, and the folder it was started in. */
class FakeAgent {
	readonly sessions: string[] = [];
	closed: string[] = [];
	disposed = false;
	private count = 0;
	supportsFork = false;
	supportsDelete = false;
	isRunning = true;
	requiresSignIn = false;
	dispose = (): void => { this.disposed = true; };
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
	prompt = async (_sessionId: string, _blocks: unknown, handlers: PromptHandlers): Promise<{ stopReason: string }> => {
		// A real agent answers over a pipe, so the turn exists before its first event arrives.
		await Promise.resolve();
		handlers.onText('hello');
		return { stopReason: 'end_turn' };
	};

	constructor(readonly root: string) { }
}

function memoryState() {
	const values = new Map<string, unknown>();
	return {
		get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
		update: (key: string, value: unknown): Promise<void> => { values.set(key, value); return Promise.resolve(); },
		keys: (): readonly string[] => [...values.keys()],
	};
}

/** A host that names each chat's folder as the request does, as the HTTP host reads `x-acp-cwd`. */
function hostWithFolders(folders: (chatId: string) => readonly string[] = () => []): HostPort {
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
		chatIdentity: request => ({ id: request.chatId, cwd: request.cwd, workspaceFolders: folders(request.chatId) }),
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

const request = (chatId: string, cwd: string): ChatRequest => {
	const messages: ChatMessage[] = [{ role: 'user', parts: [{ type: 'text', text: `hello from ${chatId}` }] }];
	return { chatId, cwd, messages, tools: [], model: 'mock-model' };
};

/** A service over fake agents, created per workspace root. */
function service(options: { folders?: (chatId: string) => readonly string[] } = {}) {
	const created: FakeAgent[] = [];
	const launch: LaunchContext = { entryPath: 'fake', installDir: '', storageDir: '', settings: {}, workspaceFolder: '/window' };
	const chat = new ChatService({
		adapter,
		host: hostWithFolders(options.folders),
		bridge: {
			registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
			updateTools: () => undefined,
			unregisterSession: () => undefined,
		},
		resolveLaunch: () => Promise.resolve(launch),
		createClient: (_adapter, ctx) => {
			const agent = new FakeAgent(ctx.workspaceFolder);
			created.push(agent);
			return agent as unknown as AgentApi;
		},
	});
	return { chat, created };
}

const respond = (chat: ChatService, chatId: string, cwd: string): Promise<void> =>
	chat.respond(request(chatId, cwd), (_event: StreamEvent) => undefined, new AbortController().signal);

describe('a process per workspace', () => {
	it('starts one agent for each folder a chat names, and reuses the agent of a folder', async () => {
		const { chat, created } = service();
		try {
			await respond(chat, 'chat-a', '/repo-a');
			await respond(chat, 'chat-b', '/repo-b');
			await respond(chat, 'chat-c', '/repo-a');

			expect(created.map(agent => agent.root)).toEqual(['/repo-a', '/repo-b']);
			expect(created[0].sessions).toHaveLength(2);
			expect(created[1].sessions).toHaveLength(1);
		} finally {
			await chat.close();
		}
	});

	it('keeps one agent for one repository, however deep in it a chat is', async () => {
		const { chat, created } = service({ folders: () => ['/repo'] });
		try {
			await respond(chat, 'chat-a', '/repo/src');
			await respond(chat, 'chat-b', '/repo/test');

			expect(created.map(agent => agent.root)).toEqual(['/repo']);
		} finally {
			await chat.close();
		}
	});

	it('keeps an agent for every folder in use, without a bound', async () => {
		const { chat, created } = service();
		try {
			const roots = ['/repo-a', '/repo-b', '/repo-c', '/repo-d', '/repo-e', '/repo-f'];
			for (const [index, root] of roots.entries()) {
				await respond(chat, `chat-${index}`, root);
			}

			expect(created.map(agent => agent.root)).toEqual(roots);
			expect(created.every(agent => !agent.disposed)).toBe(true);
			expect(chat.openSessions).toBe(roots.length);
		} finally {
			await chat.close();
		}
	});
});
