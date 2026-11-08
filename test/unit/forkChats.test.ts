/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { claudeAdapter } from '../../src/adapters/claude';
import { googleAdapter } from '../../src/adapters/google';
import type { AgentAdapter } from '../../src/core/adapter';
import type { AgentSession, ForkPoint, PromptHandlers } from '../../src/core/agentClient';
import { AcpProvider } from '../../src/core/provider';
import type { AgentApi, ProviderDeps } from '../../src/core/provider/types';
import { messageFingerprintOf, type SavedSession } from '../../src/core/sessionStore';
import { assistant, system, user } from './messages';
import { CancellationTokenSource } from './vscode-mock';

/** An agent that numbers its sessions and says one message per turn, recording what it was asked. */
class FakeAgent {
	supportsFork = true;
	supportsDelete = true;
	failFork = false;
	silent = false;
	/** What the agent reports for a turn; absent when it reports none. */
	usage: Record<string, number> | undefined;
	created: string[] = [];
	resumed: string[] = [];
	forks: Array<{ source: string; id: string; point: ForkPoint | undefined }> = [];
	closed: string[] = [];
	deleted: string[] = [];
	prompts: Array<{ sessionId: string; texts: string[] }> = [];
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
	cancel = vi.fn(() => { this.release?.(); });
	setConfigOption = vi.fn(async () => undefined);
	setSessionModel = vi.fn(async () => undefined);
	hasBackgroundTasks = () => false;
	isRunning = true;
	requiresSignIn = false;
	onDidChange = () => ({ dispose() { } });

	createSession = async (): Promise<AgentSession> => {
		const sessionId = `s${++this.sessions}`;
		this.created.push(sessionId);
		return { sessionId, configOptions: [] };
	};
	resumeSession = async (sessionId: string): Promise<AgentSession> => {
		this.resumed.push(sessionId);
		return { sessionId, configOptions: [] };
	};
	forkSession = async (source: string, _options: unknown, point?: ForkPoint): Promise<AgentSession> => {
		if (this.failFork) {
			throw new Error('The agent could not find the message to fork after');
		}
		const id = `f${++this.sessions}`;
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
			handlers.onUpdate?.({ sessionUpdate: 'agent_message_chunk', messageId: `${sessionId}-m${this.messages}`, content: { type: 'text', text } });
		}
		return { stopReason: 'end_turn', usage: this.usage && { inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: this.usage.inputTokens + this.usage.outputTokens } };
	};
}

const toolFor = (name: string) => ({ name, description: name, inputSchema: {} }) as vscode.LanguageModelChatTool;
const model = { id: 'claude-test' } as vscode.LanguageModelChatInformation;

function memento() {
	const values = new Map<string, unknown>();
	return {
		values,
		keys: () => [...values.keys()],
		get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
		update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); },
	};
}

const providers: AcpProvider[] = [];

function harness(adapter: AgentAdapter = claudeAdapter) {
	const agent = new FakeAgent();
	const state = memento();
	const logs: string[] = [];
	const deps = {
		log: (message: string) => { logs.push(message); },
		bridge: {
			registerSession: vi.fn(async () => ({ url: 'http://127.0.0.1:1/mcp', token: `token-${Math.random()}` })),
			unregisterSession: vi.fn(),
			updateTools: vi.fn(),
		},
		state,
		resolveLaunch: async () => ({ entryPath: 'test', installDir: '', storageDir: '', workspaceFolder: '/work', settings: {} }),
		client: {},
		createClient: () => agent as unknown as AgentApi,
		signIn: vi.fn(),
		showOutput: vi.fn(),
	} as unknown as ProviderDeps;
	const provider = new AcpProvider(adapter, deps);
	providers.push(provider);

	/** Sends a request of the chat `conversation`, as Copilot does, and waits for the reply. */
	async function send(messages: vscode.LanguageModelChatRequestMessage[], conversation = 'c1', tools = ['read']): Promise<unknown[]> {
		const options = { tools: tools.map(toolFor), modelOptions: { _conversationId: conversation } } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
		const parts: unknown[] = [];
		const progress = { report: (part: unknown) => { parts.push(part); } } as vscode.Progress<vscode.LanguageModelResponsePart>;
		await provider.provideLanguageModelChatResponse(model, messages, options, progress, new CancellationTokenSource().token as never);
		return parts;
	}
	return { agent, state, logs, provider, send, storeKey: `acpHub.savedSessions.${adapter.id}` };
}

const sys = system('rules');
/** The request that ends in the user's message `turn`, over a chat of replies the agent gave. */
function chat(turn: number, edits: Record<number, string> = {}): vscode.LanguageModelChatRequestMessage[] {
	const messages = [sys];
	for (let index = 1; index <= turn; index++) {
		messages.push(user(edits[index] ?? `question ${index}`));
		if (index < turn) {
			messages.push(assistant(`answer ${index}`));
		}
	}
	return messages;
}

afterEach(() => {
	for (const provider of providers.splice(0)) {
		provider.dispose();
	}
});

describe('the usage of an agent that reports no cache', () => {
	const noCacheAdapter: AgentAdapter = { ...googleAdapter, reportsCache: false };

	it('reports the tokens of a turn to Copilot without a cache hit rate', async () => {
		const { agent, send, logs } = harness(noCacheAdapter);
		agent.usage = { inputTokens: 120, outputTokens: 30 };

		const reports = await send(chat(1));

		expect(logs).toContain('Turn tokens: 120 in, 30 out.');
		expect(logs.some(line => line.startsWith('Turn cache'))).toBe(false);
		expect(logs.some(line => line.includes('NOT served from the cache') || line.includes('cache served'))).toBe(false);
		const usage = reports.find(part => (part as { mimeType?: string }).mimeType === 'usage') as { data: Uint8Array } | undefined;
		expect(usage).toBeDefined();
		expect(JSON.parse(Buffer.from(usage?.data ?? []).toString())).toMatchObject({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
	});

	it('still runs a turn when the agent reports no usage at all', async () => {
		const { agent, send, logs } = harness(noCacheAdapter);

		await send(chat(1));

		expect(agent.prompts).toHaveLength(1);
		expect(logs.some(line => line.startsWith('Turn tokens'))).toBe(false);
	});

	it('leaves session/fork to Claude; Google forks through its CLI instead', () => {
		expect(claudeAdapter.reportsCache).not.toBe(false);
		expect(googleAdapter.forkChats).not.toBe(true);
		expect(claudeAdapter.forkChats).toBe(true);
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

	it('continues a fork in the source session when the forker keeps its id, and moves the source chat to the copy', async () => {
		let closedBeforeFork: string[] = [];
		const forker = {
			locate: vi.fn(async () => 'agy'),
			fork: vi.fn(async () => {
				closedBeforeFork = [...h.agent.closed];
				return { sessionId: 's1', sourceMovedTo: 'full-copy' };
			}),
			missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
		};
		const h = harness({ ...googleAdapter, forker });
		h.agent.supportsFork = false;
		h.agent.supportsDelete = false;
		await h.send(chat(1), 'c1');
		await h.send(chat(2), 'c1');

		await h.send(chat(3), 'c2');

		// The source was let go of before its conversation was rewound, and the new chat goes on in it.
		expect(closedBeforeFork).toContain('s1');
		expect(h.agent.prompts.at(-1)).toEqual({ sessionId: 's1', texts: ['question 3'] });
		const entries = h.state.values.get(h.storeKey) as SavedSession[];
		expect(entries.find(entry => entry.key.includes('c1'))?.sessionId).toBe('full-copy');
		expect(entries.find(entry => entry.key.includes('c2'))?.sessionId).toBe('s1');

		// The source chat comes back on the whole conversation.
		await h.send(chat(3), 'c1');
		expect(h.agent.resumed).toContain('full-copy');
		expect(h.agent.prompts.at(-1)).toEqual({ sessionId: 'full-copy', texts: ['question 3'] });
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
