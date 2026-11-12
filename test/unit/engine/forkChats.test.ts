/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/claude';
import { codexAdapter } from '../../../src/adapters/codex';
import { googleAdapter } from '../../../src/adapters/google';
import { googleSessionPolicy } from '../../../src/adapters/googleSessionPolicy';
import type { AgentAdapter } from '../../../src/core/adapter';
import { policyOf, type ContinuationInput } from '../../../src/core/sessionPolicy';
import type { AgentSession, ForkPoint, PromptHandlers } from '../../../src/engine/acp/agentClient';
import { ChatService } from '../../../src/engine/chat/ChatService';
import { messageFingerprintOf, shortHash, type SavedSession } from '../../../src/engine/chat/sessionStore';
import type { AgentApi } from '../../../src/engine/chat/types';
import type { ChatMessage, ChatRequest, ToolDef } from '../../../src/engine/model/chat';
import type { StreamEvent } from '../../../src/engine/model/stream';
import type { HostPort } from '../../../src/engine/ports/host';

/** The window folder of the harness, which the agent is launched in. */
const WINDOW = '/work';

/** An agent that numbers its sessions and says one message per turn, recording what it was asked. */
class FakeAgent {
	supportsFork = true;
	supportsDelete = true;
	failFork = false;
	silent = false;
	/** What the agent reports for a turn; absent when it reports none. */
	usage: Record<string, number> | undefined;
	created: string[] = [];
	/** The folder each session was opened in, as the host resolved it. */
	createdIn: string[] = [];
	resumed: string[] = [];
	forks: Array<{ source: string; id: string; point: ForkPoint | undefined }> = [];
	closed: string[] = [];
	deleted: string[] = [];
	prompts: Array<{ sessionId: string; texts: string[] }> = [];
	/** The workspace root of every process the service opened. */
	roots: string[] = [];
	private sessions = 0;
	private messages = 0;

	ensureStarted = vi.fn(async () => undefined);
	updateContext = vi.fn(async () => undefined);
	restart = vi.fn(async () => undefined);
	stopWhenIdle = vi.fn(async () => undefined);
	signInWithMethod = vi.fn(async () => undefined);
	dispose = vi.fn();
	/** Keeps a turn open until the agent is cancelled, as a turn the user is still waiting on. */
	hold = false;
	private release: (() => void) | undefined;
	cancel = vi.fn((_sessionId: string) => { this.release?.(); });
	setConfigOption = vi.fn(async () => undefined);
	setSessionModel = vi.fn(async () => undefined);
	hasBackgroundTasks = () => false;
	isRunning = true;
	requiresSignIn = false;
	private changeListeners: Array<(change: 'restarted' | 'exited' | 'idle') => void> = [];
	onDidChange = (listener: (change: 'restarted' | 'exited' | 'idle') => void) => {
		this.changeListeners.push(listener);
		return { dispose() { } };
	};
	/** Reports a change of the process, as the client does after an idle stop or a restart. */
	change(change: 'restarted' | 'exited' | 'idle'): void {
		for (const listener of this.changeListeners) {
			listener(change);
		}
	}

	/** The session prompt each session was opened with, by session id. */
	openedWith = new Map<string, string | undefined>();

	createSession = async (options?: { cwd?: string; systemPromptAppend?: string }): Promise<AgentSession> => {
		const sessionId = `s${++this.sessions}`;
		this.created.push(sessionId);
		this.createdIn.push(options?.cwd ?? '');
		this.openedWith.set(sessionId, options?.systemPromptAppend);
		return { sessionId, configOptions: [] };
	};
	resumeSession = async (sessionId: string): Promise<AgentSession> => {
		this.resumed.push(sessionId);
		return { sessionId, configOptions: [] };
	};
	forkSession = async (source: string, options: { systemPromptAppend?: string }, point?: ForkPoint): Promise<AgentSession> => {
		if (this.failFork) {
			throw new Error('The agent could not find the message to fork after');
		}
		const id = `f${++this.sessions}`;
		this.openedWith.set(id, options.systemPromptAppend);
		this.forks.push({ source, id, point });
		return { sessionId: id, configOptions: [] };
	};
	deleteSession = async (sessionId: string) => {
		this.deleted.push(sessionId);
		return true;
	};
	closeSession = async (sessionId: string) => {
		this.closed.push(sessionId);
	};
	prompt = async (sessionId: string, blocks: ReadonlyArray<{ type: string; text?: string }>, handlers: PromptHandlers) => {
		this.prompts.push({ sessionId, texts: blocks.map(block => block.text ?? '') });
		// A real agent answers over a pipe; the turn does not exist yet while this call is starting.
		await Promise.resolve();
		if (this.hold) {
			await new Promise<void>(resolve => { this.release = resolve; });
		}
		if (!this.silent) {
			const text = `reply ${++this.messages}`;
			handlers.onText(text);
			handlers.onUpdate?.({ sessionUpdate: 'agent_message_chunk', messageId: `${sessionId}-m${this.messages}`, content: { type: 'text', text } } as never);
		}
		return { stopReason: 'end_turn', usage: this.usage && { inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: this.usage.inputTokens + this.usage.outputTokens } };
	};
}

const tool = (name: string): ToolDef => ({ name, description: name, inputSchema: {} });

function memento() {
	const values = new Map<string, unknown>();
	return {
		values,
		keys: () => [...values.keys()],
		get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
		update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); },
	};
}

const services: ChatService[] = [];

/** A store of the test's own, so the agent process runs in a folder that can be removed with the test. */
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-fork-store-'));

function harness(adapter: AgentAdapter = claudeAdapter, storageDir = storeDir, isEnabled?: () => boolean) {
	const agent = new FakeAgent();
	const state = memento();
	const logs: string[] = [];
	const host: HostPort = {
		log: (message: string) => { logs.push(message); },
		state,
		secrets: {
			get: () => Promise.resolve(undefined),
			set: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		},
		settings: { get: () => undefined },
		storageRoot: '',
		// The host names the folder of every chat, as the server does: the one the request named, or the one it was launched in.
		chatIdentity: request => ({ id: request.chatId, cwd: request.cwd || WINDOW, workspaceFolders: [] }),
		guidanceOf: request => textOf(request.messages.find(message => message.role === 'system')),
		stripHostSections: text => text,
		chatWideContextOf: () => undefined,
		executeTool: () => Promise.resolve({ content: [] }),
		ui: {
			requestSignIn: () => undefined,
			notify: () => Promise.resolve(undefined),
			openExternal: () => Promise.resolve(),
		},
	};
	const chat = new ChatService({
		adapter,
		host,
		bridge: {
			registerSession: vi.fn(async () => ({ url: 'http://127.0.0.1:1/mcp', token: `token-${Math.random()}` })),
			updateTools: vi.fn(),
			unregisterSession: vi.fn(),
		},
		resolveLaunch: async () => ({ entryPath: 'test', installDir: '', storageDir, workspaceFolder: WINDOW, settings: {} }),
		createClient: (_adapter, context) => {
			agent.roots.push(context.workspaceFolder);
			return agent as unknown as AgentApi;
		},
		// The host builds the session prompt from what it wrote into the request, as the VS Code host does.
		buildSessionPrompt: async (_tools, _folders, guidance) => guidance === undefined ? undefined : `workspace rules: ${guidance}`,
		isEnabled,
	});
	services.push(chat);

	/** Sends a request of the chat `conversation`, as the host does, and returns what the turn streamed. */
	async function send(messages: ChatMessage[], conversation = 'c1', tools = ['read'], cwd = ''): Promise<StreamEvent[]> {
		const request: ChatRequest = { chatId: conversation, cwd, messages, tools: tools.map(tool), model: 'test-model' };
		const events: StreamEvent[] = [];
		await chat.respond(request, event => events.push(event), new AbortController().signal);
		return events;
	}
	return { agent, state, logs, chat, send, storeKey: `acpHub.savedSessions.${adapter.id}` };
}

function textOf(message: ChatMessage | undefined): string | undefined {
	return message?.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
}

const sys = system('rules');

function system(text: string): ChatMessage {
	return { role: 'system', parts: [{ type: 'text', text }] };
}

function user(text: string): ChatMessage {
	return { role: 'user', parts: [{ type: 'text', text }] };
}

function assistant(text: string): ChatMessage {
	return { role: 'assistant', parts: [{ type: 'text', text }] };
}

/** The request that ends in the user's message `turn`, over a chat of replies the agent gave. */
function chat(turn: number, edits: Record<number, string> = {}): ChatMessage[] {
	const messages: ChatMessage[] = [sys];
	for (let index = 1; index <= turn; index++) {
		messages.push(user(edits[index] ?? `question ${index}`));
		if (index < turn) {
			messages.push(assistant(`answer ${index}`));
		}
	}
	return messages;
}

afterEach(async () => {
	for (const chat of services.splice(0)) {
		await chat.close();
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	try {
		fs.rmSync(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		// Left to the temp folder's own clean-up.
	}
});

describe('the usage of an agent that reports no cache', () => {
	const noCacheAdapter: AgentAdapter = { ...googleAdapter, reportsCache: false };

	it('reports the tokens of a turn to Copilot without a cache hit rate', async () => {
		const { agent, send, logs } = harness(noCacheAdapter);
		agent.usage = { inputTokens: 120, outputTokens: 30 };

		const events = await send(chat(1));

		expect(logs).toContain(`[${noCacheAdapter.id}] Turn tokens: 120 in, 30 out.`);
		expect(logs.some(line => line.startsWith(`[${noCacheAdapter.id}] Turn cache`))).toBe(false);
		expect(logs.some(line => line.includes('NOT served from the cache') || line.includes('cache served'))).toBe(false);
		const usage = events.find(event => event.type === 'usage');
		expect(usage).toEqual({ type: 'usage', promptTokens: 120, cachedTokens: 0, outputTokens: 30, reasoningTokens: 0 });
	});

	it('still runs a turn when the agent reports no usage at all', async () => {
		const { agent, send, logs } = harness(noCacheAdapter);

		await send(chat(1));

		expect(agent.prompts).toHaveLength(1);
		expect(logs.some(line => line.includes('Turn tokens'))).toBe(false);
	});

	it('leaves session/fork to Claude; Google forks through its CLI instead', async () => {
		const h = harness();
		await h.send(chat(1));
		const [saved] = h.state.values.get(h.storeKey) as SavedSession[];
		const input: ContinuationInput = { saved, live: [], editedOwnChat: true, agentSupportsFork: true, externalForker: googleAdapter.forker };

		expect(claudeAdapter.reportsCache).not.toBe(false);
		expect(policyOf(claudeAdapter).planContinuation({ ...input, externalForker: undefined })).toEqual({ how: 'fork-native' });
		expect(policyOf(googleAdapter).planContinuation(input)).toMatchObject({ how: 'fork-external' });
	});
});

describe('the folder a chat session is opened in', () => {
	/** The agent process is rooted in its own workspace, with a drive letter of its own choosing. */
	const lowerDrive = (folder: string) => folder.replace(/^[A-Z]:/, drive => drive.toLowerCase());

	it('is the agent\'s own workspace, whatever folder the request names', async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-cwd-'));
		try {
			const { agent, send } = harness();

			await send(chat(1), 'c1');
			await send([user('question 1')], 'c2', ['read'], folder);

			// The request's own folder reaches the model through the prompt, never through the session's cwd.
			expect(agent.createdIn).toEqual([lowerDrive(path.resolve(storeDir, 'workspace')), lowerDrive(path.resolve(storeDir, 'workspace'))]);
			expect(agent.roots).toEqual([lowerDrive(path.resolve(storeDir, 'workspace'))]);
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe('external conversation forking', () => {
	it('forks and resumes a checkpoint even when the agent does not support session/fork', async () => {
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async () => ({ sessionId: 'external-copy' })),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const { agent, send } = harness({ ...googleAdapter, forker });
		agent.supportsFork = false;
		agent.supportsDelete = false;
		await send(chat(1));
		await send(chat(2));

		await send(chat(2, { 2: 'edited question' }));

		// The forker is handed the program the agent was launched with ('test' in this harness).
		expect(forker.locate).toHaveBeenCalledWith({}, expect.any(Function), 'test');
		expect(forker.fork).toHaveBeenCalledWith('agy', expect.objectContaining({ sessionId: 's1', point: expect.objectContaining({ messageFingerprint: messageFingerprintOf('reply 1') }) }), expect.any(Function));
		expect(agent.resumed).toContain('external-copy');
		expect(agent.prompts.at(-1)).toEqual({ sessionId: 'external-copy', texts: ['edited question'] });
	});

	it('restarts the agent after a rewind, so it reads the conversation again, before opening the fork', async () => {
		const order: string[] = [];
		let closedBeforeFork: string[] = [];
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async (_program: string, request: { keepSourceId: boolean }) => {
				closedBeforeFork = [...h.agent.closed];
				order.push(`fork keepSourceId=${request.keepSourceId}`);
				return { sessionId: 's1', sourceMovedTo: 'full-copy' };
			}),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const h = harness({ ...googleAdapter, forker });
		h.agent.supportsFork = false;
		h.agent.restart.mockImplementation(async () => { order.push('restart'); });
		h.agent.resumeSession = (async (sessionId: string) => { order.push(`resume ${sessionId}`); return { sessionId, configOptions: [] }; }) as never;
		await h.send(chat(1), 'c1');
		await h.send(chat(2), 'c1');

		await h.send(chat(2, { 2: 'edited question' }), 'c1');

		expect(closedBeforeFork).toContain('s1');
		// The restart runs beside the fork and is done before the copy is opened.
		expect(order).toContain('fork keepSourceId=true');
		expect(order.at(-1)).toBe('resume s1');
		expect(order.indexOf('restart')).toBeLessThan(order.indexOf('resume s1'));
		// Starting the agent again runs beside the fork instead of after it.
		expect(h.agent.ensureStarted).toHaveBeenCalled();
		expect(order.indexOf('resume s1')).toBeGreaterThan(order.indexOf('fork keepSourceId=true'));
	});

	it('rebuilds from the transcript when the restart fails, rather than continue on the whole conversation', async () => {
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async () => ({ sessionId: 's1', sourceMovedTo: 'full-copy' })),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const h = harness({ ...googleAdapter, forker });
		h.agent.supportsFork = false;
		h.agent.restart.mockImplementation(async () => { throw new Error('restart failed'); });
		await h.send(chat(1), 'c1');
		await h.send(chat(2), 'c1');

		await h.send(chat(2, { 2: 'edited question' }), 'c1');

		expect(h.agent.resumed).not.toContain('s1');
		expect(h.agent.prompts.at(-1)?.texts.join('\n')).toContain('question 1');
	});

	it('leaves the source id alone when another chat is in the middle of a turn', async () => {
		let keepSourceId: boolean | undefined;
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async (_program: string, request: { keepSourceId: boolean }) => {
				keepSourceId = request.keepSourceId;
				return { sessionId: 'copy-of-other' };
			}),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const h = harness({ ...googleAdapter, forker });
		h.agent.supportsFork = false;
		h.agent.hold = true;
		void h.send(chat(1), 'busy');
		await vi.waitFor(() => expect(h.agent.prompts).toHaveLength(1));
		h.agent.hold = false;

		await h.send(chat(1), 'c1');
		await h.send(chat(2), 'c1');
		await h.send(chat(2, { 2: 'edited question' }), 'c1');

		expect(keepSourceId).toBe(false);
		expect(h.agent.restart).not.toHaveBeenCalled();
		expect(h.agent.prompts.at(-1)).toEqual({ sessionId: 'copy-of-other', texts: ['edited question'] });
	});

	it('does not keep the source id when another chat starts a turn while the forker is being located', async () => {
		let resolveLocate: (program: string) => void = () => { };
		const forker = {
			locate: vi.fn(() => new Promise<string>(resolve => { resolveLocate = resolve; })),
			fork: vi.fn(async (_program: string, _request: { keepSourceId: boolean }) => ({ sessionId: 's1' })),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const h = harness({ ...googleAdapter, forker });
		h.agent.supportsFork = false;
		await h.send(chat(1), 'c1');
		await h.send(chat(2), 'c1');

		// The reuse request reaches the forker, which waits to say where its program is.
		const forking = h.send(chat(2, { 2: 'edited question' }), 'c1');
		await vi.waitFor(() => expect(forker.locate).toHaveBeenCalled());

		// Another chat starts a turn while the program is still being looked for.
		h.agent.hold = true;
		void h.send(chat(1), 'c2');
		await vi.waitFor(() => expect(h.agent.prompts).toHaveLength(3));
		h.agent.hold = false;

		resolveLocate('agy');
		await forking;

		// Its turn is read, so the fork takes an id of its own: the restart a kept id needs would end that turn.
		expect(forker.fork).toHaveBeenCalledWith('agy', expect.objectContaining({ sessionId: 's1', keepSourceId: false }), expect.any(Function));
		expect(h.agent.restart).not.toHaveBeenCalled();
	});

	it('continues an edited chat in the source session when the forker keeps its id', async () => {
		let closedBeforeFork: string[] = [];
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async (_program: string, request: { keepSourceId: boolean }) => {
				closedBeforeFork = [...h.agent.closed];
				expect(request.keepSourceId).toBe(true);
				return { sessionId: 's1', sourceMovedTo: 'full-copy' };
			}),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const h = harness({ ...googleAdapter, forker });
		h.agent.supportsFork = false;
		h.agent.supportsDelete = false;
		await h.send(chat(1), 'c1');
		await h.send(chat(2), 'c1');

		await h.send(chat(2, { 2: 'edited question' }), 'c1');

		// The source was let go of before its conversation was rewound, and the edited chat goes on in it.
		expect(closedBeforeFork).toContain('s1');
		expect(h.agent.prompts.at(-1)).toEqual({ sessionId: 's1', texts: ['edited question'] });
	});

	it('leaves the chat a copy was taken from in its own session, and gives the copy an id of its own', async () => {
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async (_program: string, request: { keepSourceId: boolean }) => {
				expect(request.keepSourceId).toBe(false);
				return { sessionId: 'copy-of-c1' };
			}),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const h = harness({ ...googleAdapter, forker });
		h.agent.supportsFork = false;
		h.agent.supportsDelete = false;
		await h.send(chat(1), 'c1');
		await h.send(chat(2), 'c1');

		await h.send(chat(3), 'c2');

		expect(h.agent.prompts.at(-1)).toEqual({ sessionId: 'copy-of-c1', texts: ['question 3'] });
		expect(h.agent.restart).not.toHaveBeenCalled();
		const entries = h.state.values.get(h.storeKey) as SavedSession[];
		expect(entries.find(entry => entry.key.includes('c1'))?.sessionId).toBe('s1');

		// The chat the copy was taken from goes on in the session it had, which is still open: nothing closes or
		// resumes it, since a conversation that is opened again is sent to the model uncached.
		await h.send(chat(3), 'c1');
		expect(h.agent.closed).not.toContain('s1');
		expect(h.agent.resumed).not.toContain('s1');
		expect(h.agent.prompts.at(-1)).toEqual({ sessionId: 's1', texts: ['question 3'] });
	});

	it('uses a transcript when the external CLI is missing or declined', async () => {
		const forker = {
			locate: vi.fn(async () => undefined),
			fork: vi.fn(async () => ({ sessionId: 'unused' })),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const { agent, state, send } = harness({ ...googleAdapter, forker });
		agent.supportsFork = false;
		await send(chat(1));
		await send(chat(2));
		await send(chat(2, { 2: 'edited question' }));
		expect(state.values.get('acpHub.forkNotice.google')).toBe('shown');
		expect(agent.prompts.at(-1)?.texts.join('\n')).toContain('question 1');
		state.values.set('acpHub.forkNotice.google', 'declined');
		await send(chat(2, { 2: 'edited again' }));
		expect(forker.locate).toHaveBeenCalledOnce();
		expect(forker.fork).not.toHaveBeenCalled();
		expect(agent.prompts.at(-1)?.texts.join('\n')).toContain('edited again');
	});

	it('falls back to the transcript when the external fork fails', async () => {
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async () => { throw new Error('fork failed'); }),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const { agent, send } = harness({ ...googleAdapter, forker });
		agent.supportsFork = false;
		await send(chat(1));
		await send(chat(2));
		await send(chat(2, { 2: 'edited question' }));

		expect(agent.created).toEqual(['s1', 's2']);
		expect(agent.resumed).toEqual([]);
		expect(agent.prompts.at(-1)?.texts.join('\n')).toContain('question 1');
		expect(agent.prompts.at(-1)?.texts.join('\n')).toContain('edited question');
	});
});

describe('forking a chat at a checkpoint', () => {
	it('continues the live session in place when the request extends it', async () => {
		const { agent, send } = harness();

		await send(chat(1));
		await send(chat(2));

		expect(agent.created).toEqual(['s1']);
		expect(agent.forks).toEqual([]);
		expect(agent.prompts.map(prompt => prompt.sessionId)).toEqual(['s1', 's1']);
		expect(agent.prompts[1].texts).toEqual(['question 2']);
	});

	it('records a checkpoint at the end of each turn', async () => {
		const { send, state, storeKey } = harness();

		await send(chat(1));
		await send(chat(2));

		const [entry] = state.values.get(storeKey) as SavedSession[];
		expect(entry.version).toBe(2);
		expect(entry.checkpoints).toMatchObject([
			{ messages: 3, messageId: 's1-m1', fingerprint: messageFingerprintOf('reply 1'), occurrence: 1, messageCounts: { [messageFingerprintOf('reply 1')]: 1 } },
			{ messages: 5, messageId: 's1-m2', fingerprint: messageFingerprintOf('reply 2'), occurrence: 1, messageCounts: { [messageFingerprintOf('reply 1')]: 1, [messageFingerprintOf('reply 2')]: 1 } },
		]);
	});

	it('forks the turn an edit of an earlier message still agrees with', async () => {
		const { agent, send } = harness();
		await send(chat(1));
		await send(chat(2));
		await send(chat(3));

		await send(chat(2, { 2: 'question 2, reworded' }));

		expect(agent.created).toEqual(['s1']);
		expect(agent.forks).toEqual([{ source: 's1', id: 'f2', point: { messageId: 's1-m1', messageFingerprint: messageFingerprintOf('reply 1'), messageOccurrence: 1 } }]);
		expect(agent.closed).toContain('s1');
		expect(agent.prompts.at(-1)).toEqual({ sessionId: 'f2', texts: ['question 2, reworded'] });
	});

	it('leaves the prompt of a forked Claude chat to the current host prompt', async () => {
		const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-prompt-'));
		try {
			const { agent, send } = harness(claudeAdapter, storageDir);
			await send(chat(1));
			await send(chat(2));
			await send([system('other rules'), ...chat(2, { 2: 'question 2, reworded' }).slice(1)]);

			expect(agent.openedWith.get('f2')).toContain('other rules');
			expect(fs.existsSync(path.join(storageDir, 'prompts'))).toBe(false);
		} finally {
			fs.rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it('opens a forked Google chat with the prompt the saved session began with, so a reworded host prompt does not miss the cache', async () => {
		const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-prompt-'));
		try {
			// A Google adapter that forks with the agent's own `session/fork`, as the flag it replaced asked for.
			const { agent, send, logs } = harness({ ...googleAdapter, forker: undefined, sessionPolicy: { ...googleSessionPolicy, planContinuation: () => ({ how: 'fork-native' }) } }, storageDir);
			await send(chat(1));
			await send(chat(2));
			const original = agent.openedWith.get('s1') ?? '';
			expect(original).toContain('rules');
			// The prompt is kept aside for the fork that reaches for it; the next request must find it whole.
			const archive = path.join(storageDir, 'prompts', `${shortHash(original)}.txt`);
			await vi.waitFor(() => expect(fs.existsSync(archive) && fs.readFileSync(archive, 'utf8') === original).toBe(true));
			// The host rewords its prompt between the edit and the turns before it.
			const reworded = (messages: ChatMessage[]) => [system('other rules'), ...messages.slice(1)];

			await send(reworded(chat(2, { 2: 'question 2, reworded' })));

			expect(agent.forks).toHaveLength(1);
			expect(agent.openedWith.get('f2')).toBe(original);
			expect(logs.some(line => line.includes('Sending the session prompt the saved session began with'))).toBe(true);
		} finally {
			fs.rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it('forks the deepest checkpoint when the last message is edited', async () => {
		const { agent, send } = harness();
		await send(chat(1));
		await send(chat(2));
		await send(chat(3));

		await send(chat(3, { 3: 'question 3, reworded' }));

		expect(agent.forks).toHaveLength(1);
		expect(agent.forks[0].point?.messageId).toBe('s1-m2');
		expect(agent.prompts.at(-1)).toEqual({ sessionId: 'f2', texts: ['question 3, reworded'] });
	});

	it('goes on from the fork in place, and an edit of its own turns forks again', async () => {
		const { agent, send, state, storeKey } = harness();
		await send(chat(1));
		await send(chat(2));
		await send(chat(2, { 2: 'question 2, reworded' }));
		await send(chat(3, { 2: 'question 2, reworded' }));

		expect(agent.prompts.slice(-2).map(prompt => prompt.sessionId)).toEqual(['f2', 'f2']);
		const [entry] = state.values.get(storeKey) as SavedSession[];
		expect(entry.sessionId).toBe('f2');
		expect(entry.forked).toBe(true);
		expect(entry.checkpoints?.map(checkpoint => checkpoint.messages)).toEqual([3, 5, 7]);
	});

	it('forks a copy of a chat taken from its end under a new conversation', async () => {
		const { agent, send } = harness();
		await send(chat(1));
		await send(chat(2));

		await send(chat(3), 'c2');

		expect(agent.forks).toHaveLength(1);
		expect(agent.forks[0].source).toBe('s1');
		expect(agent.forks[0].point?.messageId).toBe('s1-m2');
		expect(agent.prompts.at(-1)).toEqual({ sessionId: 'f2', texts: ['question 3'] });
	});

	it('cancels a turn still running in the chat it forks from, then forks the last finished turn', async () => {
		const { agent, send } = harness();
		await send(chat(1));
		await send(chat(2));
		agent.hold = true;
		const running = send(chat(3));
		await vi.waitFor(() => expect(agent.prompts).toHaveLength(3));
		agent.hold = false;

		await send(chat(3), 'c2');
		await running;

		expect(agent.cancel).toHaveBeenCalledWith('s1');
		expect(agent.created).toEqual(['s1']);
		expect(agent.forks).toHaveLength(1);
		expect(agent.forks[0].source).toBe('s1');
		expect(agent.forks[0].point?.messageId).toBe('s1-m2');
		expect(agent.prompts.at(-1)).toEqual({ sessionId: 'f2', texts: ['question 3'] });
	});

	it('forks a side chat, which offers other tools than the chat it comes from', async () => {
		const { agent, send } = harness();
		await send(chat(1));
		await send(chat(2));

		await send(chat(3), 'side', ['read', 'search']);

		expect(agent.forks.map(fork => fork.source)).toEqual(['s1']);
		expect(agent.prompts.at(-1)?.texts).toEqual(['question 3']);
	});

	it('forks from the middle of a copied chat', async () => {
		const { agent, send } = harness();
		await send(chat(1));
		await send(chat(2));
		await send(chat(3));

		await send(chat(2), 'c2');

		expect(agent.forks).toHaveLength(1);
		expect(agent.forks[0].point?.messageId).toBe('s1-m1');
		expect(agent.prompts.at(-1)?.texts).toEqual(['question 2']);
	});

	it('starts a new session with the transcript when no checkpoint matches', async () => {
		const { agent, send } = harness();
		await send(chat(1));
		await send(chat(2));

		await send(chat(2, { 1: 'another first question' }));

		expect(agent.forks).toEqual([]);
		expect(agent.created).toEqual(['s1', 's2']);
		expect(agent.prompts.at(-1)?.sessionId).toBe('s2');
	});

	it('falls back to a new session with the transcript when the fork fails', async () => {
		const { agent, send, logs } = harness();
		await send(chat(1));
		await send(chat(2));
		agent.failFork = true;

		await send(chat(2, { 2: 'question 2, reworded' }));

		expect(agent.forks).toEqual([]);
		expect(agent.created).toEqual(['s1', 's2']);
		const last = agent.prompts.at(-1);
		expect(last?.sessionId).toBe('s2');
		expect(last?.texts.join('\n')).toContain('question 1');
		expect(last?.texts.join('\n')).toContain('question 2, reworded');
		expect(logs.some(line => line.includes('Could not fork saved session'))).toBe(true);
	});

	it('does not fork after a turn that ended without a message of the agent', async () => {
		const { agent, send } = harness();
		agent.silent = true;
		await send(chat(1));
		await send(chat(2));

		await send(chat(2, { 2: 'question 2, reworded' }));

		expect(agent.forks).toEqual([]);
		expect(agent.created).toEqual(['s1', 's2']);
	});

	it('does not fork when the agent did not advertise it', async () => {
		const { agent, send } = harness();
		agent.supportsFork = false;
		await send(chat(1));
		await send(chat(2));

		await send(chat(2, { 2: 'question 2, reworded' }));
		await send(chat(3), 'c2');

		expect(agent.forks).toEqual([]);
		expect(agent.created).toEqual(['s1', 's2', 's3']);
	});

	it('does not fork for an adapter that leaves forking off', async () => {
		const { agent, send } = harness(googleAdapter);
		await send(chat(1));
		await send(chat(2));

		await send(chat(2, { 2: 'question 2, reworded' }));

		expect(agent.forks).toEqual([]);
		expect(agent.created).toEqual(['s1', 's2']);
	});

	it('does not take a changed IDE selection for an edit', async () => {
		const { agent, send } = harness();
		const selected = (lines: string) => user(`<ide_selection>lines ${lines}</ide_selection>\nquestion 1`);
		await send([sys, selected('1-2')]);

		await send([sys, selected('7-9'), assistant('answer 1'), user('question 2')]);

		expect(agent.created).toEqual(['s1']);
		expect(agent.forks).toEqual([]);
		expect(agent.prompts.at(-1)).toEqual({ sessionId: 's1', texts: ['question 2'] });
	});

	it('forks a session saved before checkpoints existed only at its end', async () => {
		const { agent, send, state, storeKey } = harness();
		await send(chat(1));
		await send(chat(2));
		const old = (state.values.get(storeKey) as SavedSession[]).map(({ version: _version, checkpoints: _checkpoints, ...entry }) => entry);
		state.values.set(storeKey, old);

		await send(chat(3), 'c2');

		expect(agent.forks).toEqual([{ source: 's1', id: 'f2', point: undefined }]);
		const entries = state.values.get(storeKey) as SavedSession[];
		expect(entries.every(entry => entry.version === 2)).toBe(true);
	});

	it('deletes a forked session that no entry names any more, but not the one a chat still uses', async () => {
		const { agent, send, state, storeKey } = harness();
		await send(chat(1));
		await send(chat(2));
		await send(chat(2, { 2: 'question 2, reworded' }));
		await send(chat(2, { 2: 'question 2, reworded again' }));
		expect((state.values.get(storeKey) as SavedSession[])[0].sessionId).toBe('f3');
		expect(agent.deleted).toEqual([]);

		await send(chat(1), 'other chat');

		await vi.waitFor(() => expect(agent.deleted).toEqual(['f2']));
	});

	it('leaves the forked sessions alone for an agent that cannot delete', async () => {
		const { agent, send, state, storeKey } = harness();
		agent.supportsDelete = false;
		await send(chat(1));
		await send(chat(2));
		await send(chat(2, { 2: 'question 2, reworded' }));
		await send(chat(2, { 2: 'question 2, reworded again' }));

		await send(chat(1), 'other chat');

		expect(agent.deleted).toEqual([]);
		expect(state.values.get(`${storeKey}.deletions`)).toEqual(['f2']);
	});
});

describe('starting an agent again that the idle shutdown stopped', () => {
	it('starts the agent and its warm session when the user is back, so the next chat does not wait for it', async () => {
		const { agent, send, chat: service, logs } = harness(codexAdapter);
		await send(chat(1));
		agent.isRunning = false;
		agent.change('idle');
		const created = agent.created.length;

		service.wakeAfterIdle();

		await vi.waitFor(() => expect(agent.created).toHaveLength(created + 1));
		expect(logs.some(line => line.includes(`starting the ${codexAdapter.displayName} agent it stopped for being idle`))).toBe(true);
	});

	it('starts it once per idle stop', async () => {
		const { agent, send, chat: service } = harness(codexAdapter);
		await send(chat(1));
		agent.isRunning = false;
		agent.change('idle');
		const created = agent.created.length;

		service.wakeAfterIdle();
		await vi.waitFor(() => expect(agent.created).toHaveLength(created + 1));
		service.wakeAfterIdle();
		await Promise.resolve();

		expect(agent.created).toHaveLength(created + 1);
	});

	it('leaves alone an agent that was never stopped, or that a request already started again', async () => {
		const { agent, send, chat: service } = harness(codexAdapter);
		service.wakeAfterIdle();
		await send(chat(1));
		agent.change('idle');
		await send(chat(1), 'c2');
		const created = agent.created.length;

		service.wakeAfterIdle();
		await Promise.resolve();

		expect(agent.created).toHaveLength(created);
	});
});

describe('the session prompt of a new chat', () => {
	const contextOf = (id: string): string => `<session_context>\nSession folder: c:/Users/me/.copilot/session-state/${id}\n</session_context>`;
	const rulesOf = (id: string): ChatMessage => system(`Rules of the host.\n\n${contextOf(id)}\n\nMore rules.`);
	const ids = ['2286601f-d0d5-4d73-9762-f7ecef8248fd', '9a99ab0d-0341-4b20-b3ce-f0499abbc44a'];

	it.each([['Claude', claudeAdapter], ['Codex', codexAdapter], ['Google', googleAdapter]])('is the same for two chats of %s whose guidance differs only in the session folder', async (_name, adapter) => {
		const { agent, send } = harness(adapter);

		await send([rulesOf(ids[0]), user('hello')], 'chat-one');
		await send([rulesOf(ids[1]), user('hello')], 'chat-two');

		const [one, other] = [...agent.openedWith.values()];
		expect(one).toBeDefined();
		expect(one).toBe(other);
		expect(one).not.toContain('session-state');
	});

	it('gives the agent the session folder of the chat in the message that opens the session', async () => {
		const { agent, send } = harness();

		await send([rulesOf(ids[1]), user('hello')], 'chat-two');

		expect(agent.prompts[0].texts.join('\n')).toContain(contextOf(ids[1]));
	});

	it('does not repeat the session folder in the next message of the chat', async () => {
		const { agent, send } = harness();

		await send([rulesOf(ids[0]), user('hello')], 'chat-one');
		await send([rulesOf(ids[0]), user('hello'), assistant('reply 1'), user('again')], 'chat-one');

		expect(agent.prompts[1].texts.join('\n')).not.toContain('session-state');
	});
});
