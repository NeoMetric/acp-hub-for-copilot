/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeadlessComposition } from '../../src/composition/headless';
import type { AgentAdapter } from '../../src/core/adapter';
import { nativeSessionPolicy } from '../../src/core/nativeSessionPolicy';
import type { CancellationToken } from '../../src/engine/acp/emitter';
import { ChatService } from '../../src/engine/chat/ChatService';
import type { ToolBridge } from '../../src/engine/chat/types';
import { McpBridge } from '../../src/engine/mcp/bridge';
import type { ChatRequest, Part } from '../../src/engine/model/chat';
import type { StreamEvent } from '../../src/engine/model/stream';
import { settingKey } from '../../src/core/settings';
import { createHeadlessHost, type HeadlessHost } from '../../src/hosts/http/host';
import { createServer } from '../../src/hosts/http/server';
import { mockAdapter } from './engine/serverHarness';

const MOCK_AGENT = path.resolve(__dirname, '..', 'fixtures', 'mock-acp-agent.cjs');
const NO_LOG = (): void => undefined;

/** The mock ACP agent, which streams "hello" and ends its turn. */
const adapter: AgentAdapter = {
	id: 'mock',
	displayName: 'Mock',
	vendor: 'acphub-mock',
	install: { kind: 'existing-cli', command: 'node' },
	launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: 'normal' } }),
	auth: [],
	settings: [],
	modelPolicy: {} as AgentAdapter['modelPolicy'],
	systemPrompt: { toolAccess: '', listRequiredArguments: false },
};

/** The engine's loopback bridge as the host sees it: a call reaches the request that owns it. */
function toolsOver(loopback: McpBridge): ToolBridge {
	return {
		registerSession: (tools, execute, options) => loopback.registerSession(tools, async (name, input, token) => {
			const result = await execute(name, input, signalOf(token));
			return result && { content: result.content.map(toBridgePart), isError: result.isError };
		}, options),
		updateTools: (token, tools) => loopback.updateTools(token, tools),
		unregisterSession: token => loopback.unregisterSession(token),
	};
}

/** A neutral part as the bridge hands it to the agent: its text, or an image's bytes. */
function toBridgePart(part: Part): unknown {
	return part.type === 'text' ? part.text : part;
}

/** A cancellation the engine reports as the plain signal the rest of the engine watches. */
function signalOf(token: CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}

const cleanups: Array<() => Promise<void>> = [];

/** How a test's server is set up: the agent it serves, its token, and a wait that replaces every agent's own. */
interface BootOptions {
	readonly token?: string;
	readonly toolCallWaitMs?: number;
	readonly streamKeepAliveMs?: number;
	readonly adapter?: AgentAdapter;
	/** A service of the test's own, in place of the one over the mock agent. */
	readonly service?: ChatService;
	/** Sees every line the server logs. */
	readonly log?: (message: string, level?: string) => void;
}

/** Starts the server on a free port over the mock agent, with a store root of its own. */
async function start(options: BootOptions = {}): Promise<string> {
	return (await boot(options)).url;
}

/** Starts the server and hands its host back too, so a test can change what the control page would. */
async function boot(options: BootOptions = {}): Promise<{ url: string; host: HeadlessHost }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-server-'));
	const host = createHeadlessHost({ root, log: options.log ?? NO_LOG });
	const loopback = new McpBridge(NO_LOG);
	const agent = options.adapter ?? adapter;
	const service = options.service ?? new ChatService({
		adapter: agent,
		host,
		bridge: toolsOver(loopback),
		resolveLaunch: () => Promise.resolve({ entryPath: MOCK_AGENT, installDir: '', storageDir: path.join(root, 'agent'), workspaceFolder: root, settings: {} }),
		// The gate the composition hands the engine, read from `config.json` on every call.
		isEnabled: () => host.settings.get<boolean>(settingKey(agent.id, 'enabled')) !== false,
	});
	const composition: HeadlessComposition = {
		host,
		adapters: [agent],
		serviceOf: id => id === agent.id ? service : undefined,
		close: () => service.close(),
	};
	const server = createServer({ composition, token: options.token, toolCallWaitMs: options.toolCallWaitMs, streamKeepAliveMs: options.streamKeepAliveMs });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	cleanups.push(async () => {
		const closed = new Promise<void>(resolve => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
		await composition.close();
		loopback.dispose();
		// The agent ran in the store, and a process keeps the folder it runs in until it is gone.
		try {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch {
			// Left to the temp folder's own clean-up.
		}
	});
	return { url: `http://127.0.0.1:${address.port}`, host };
}

function post(url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** One OpenAI chat request, as a stock client writes it. */
function chat(model: string, text = 'hi'): Record<string, unknown> {
	return { model, messages: [{ role: 'user', content: text }] };
}

/** The first model the mock agent offers, as the endpoint publishes it. */
async function firstModel(url: string): Promise<string> {
	const response = await fetch(`${url}/v1/models`);
	const body = await response.json() as { data: Array<{ id: string }> };
	const model = body.data.find(entry => entry.id.startsWith(`${adapter.id}/`));
	expect(model, 'the mock agent offers a model').toBeDefined();
	return model!.id;
}

/** The tool the mock agent asks for and the HTTP client has to run. */
const TOOL = {
	type: 'function',
	function: { name: 'do_a_thing', description: 'Answers a question.', parameters: { type: 'object', properties: { answer: { type: 'number' } } } },
};

/** A chat whose agent calls {@link TOOL}, so the client is the one that has to run it. */
function toolChat(model: string): Record<string, unknown> {
	return { model, tools: [TOOL], messages: [{ role: 'user', content: 'tool' }] };
}

/** The first request of a tool turn, or the body of any completion the test reads. */
async function bodyOf(response: Response): Promise<any> {
	expect(response.status).toBe(200);
	return response.json() as Promise<any>;
}

/** The `data:` payloads of an SSE response, in order. */
function payloadsOf(text: string): string[] {
	return text.split('\n\n')
		.map(part => part.trim())
		.filter(part => part.startsWith('data:'))
		.map(part => part.slice('data:'.length).trim());
}

/** The chunks of an SSE response, without the `[DONE]` that ends it. */
function chunksOf(text: string): any[] {
	return payloadsOf(text).filter(payload => payload !== '[DONE]').map(payload => JSON.parse(payload));
}

/**
 * A service of the test's own: it keeps the request the server built and
 * answers with the events the test names, so a body and a failure can be read
 * without an agent behind it.
 */
function stubService(events: StreamEvent[] | (() => never) = [{ type: 'text', text: 'hello' }]): { service: ChatService; requests: ChatRequest[] } {
	const requests: ChatRequest[] = [];
	const service = {
		adapter,
		enabled: true,
		openSessions: 0,
		client: () => Promise.resolve({}),
		start: () => Promise.resolve(),
		close: () => Promise.resolve(),
		respond: (request: ChatRequest, sink: (event: StreamEvent) => void) => {
			requests.push(request);
			if (typeof events === 'function') {
				return Promise.reject(new Error('The engine broke.'));
			}
			for (const event of events) {
				sink(event);
			}
			return Promise.resolve();
		},
	};
	return { service: service as unknown as ChatService, requests };
}

/** One completion body against a stubbed service, and the request the server built for it. */
async function ask(body: Record<string, unknown>, events?: StreamEvent[] | (() => never)): Promise<{ response: Response; requests: ChatRequest[] }> {
	const stub = stubService(events);
	const { url } = await boot({ service: stub.service });
	const response = await post(`${url}/v1/chat/completions`, { model: `${adapter.id}/mock-1`, messages: [{ role: 'user', content: 'hi' }], ...body });
	return { response, requests: stub.requests };
}

/** What a stream delivers until it says what the test waits for, or the deadline passes. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, ms: number): Promise<string> {
	const decoder = new TextDecoder();
	const until = Date.now() + ms;
	let text = '';
	while (Date.now() < until && !text.includes(needle)) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		text += decoder.decode(value, { stream: true });
	}
	return text;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

describe('the HTTP server', () => {
	it('answers a completion with the assistant text', async () => {
		const url = await start();
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, chat(model));

		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.object).toBe('chat.completion');
		expect(body.model).toBe(model);
		expect(body.choices[0].message.role).toBe('assistant');
		expect(body.choices[0].message.content).toBe('hello');
		expect(body.choices[0].finish_reason).toBe('stop');
		expect(body.usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
		expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
	});

	it('streams the turn as SSE and ends it with [DONE]', async () => {
		const url = await start();
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, { ...chat(model), stream: true });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const payloads = payloadsOf(await response.text());
		expect(payloads.at(-1)).toBe('[DONE]');
		const chunks = payloads.slice(0, -1).map(payload => JSON.parse(payload));
		expect(chunks[0].choices[0].delta.role).toBe('assistant');
		expect(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join('')).toBe('hello');
		expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
	});

	it('lists the models of the agent under its id', async () => {
		const url = await start();

		const response = await fetch(`${url}/v1/models`);

		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.object).toBe('list');
		const ids: string[] = body.data.map((entry: { id: string }) => entry.id);
		expect(ids.some(id => id.startsWith('mock/'))).toBe(true);
		for (const entry of body.data as Array<{ object: string; owned_by: string }>) {
			expect(entry.object).toBe('model');
			expect(entry.owned_by).toBe(adapter.id);
		}
	});

	it('reads the models again on request, and names the agent that answered', async () => {
		const url = await start({ adapter: mockAdapter() });

		const response = await post(`${url}/v1/models/refresh`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ refreshed: [adapter.id] });
	});

	it('refuses the refresh route to a method it does not serve', async () => {
		const url = await start();

		const response = await fetch(`${url}/v1/models/refresh`);

		expect(response.status).toBe(405);
	});

	describe('the names the user chose for models', () => {
		const info = { name: 'Alpha', family: 'mock', version: '1', maxInputTokens: 1000, maxOutputTokens: 100, toolCalling: true, imageInput: false, efforts: [] };

		async function entryOf(names: unknown): Promise<any> {
			const { url, host } = await boot();
			await host.state.update('server.models.mock', [{ value: 'm1', info }]);
			if (names !== undefined) {
				await host.state.update('server.modelNames', names);
			}
			const body = await (await fetch(`${url}/v1/models`)).json() as any;
			return body.data.find((entry: { id: string }) => entry.id === 'mock/m1');
		}

		it('publishes the chosen name and keeps the id', async () => {
			const entry = await entryOf({ providers: {}, models: { mock: { m1: 'My Alpha' } } });

			expect(entry.acp.name).toBe('My Alpha');
			expect(entry.owned_by).toBe('mock');
		});

		it('publishes the agent\'s own name when none was chosen', async () => {
			const entry = await entryOf(undefined);

			expect(entry.acp.name).toBe('Alpha');
		});
	});

	it('answers an unknown model with a 404 in the OpenAI error shape', async () => {
		const url = await start();

		const response = await post(`${url}/v1/chat/completions`, chat('nobody/nothing'));

		expect(response.status).toBe(404);
		const body = await response.json() as any;
		expect(typeof body.error.message).toBe('string');
		expect(body.error.message.length).toBeGreaterThan(0);
		expect(body.error.code).toBe('model_not_found');
	});

	it('answers the health probe with the agents it can drive', async () => {
		const url = await start();

		const response = await fetch(`${url}/health`);

		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.agents).toEqual([expect.objectContaining({ id: adapter.id, installed: true, openSessions: 0 })]);
		expect(body.openSessions).toBe(0);
	});

	it('logs when a request arrives and when its prompt goes to the agent, once per request', async () => {
		const lines: string[] = [];
		const { url } = await boot({ log: message => { lines.push(message); } });
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, chat(model));

		expect(response.status).toBe(200);
		expect(lines.filter(line => line.endsWith('Request received'))).toHaveLength(1);
		expect(lines.filter(line => line.endsWith('Prompt sent'))).toHaveLength(1);
		expect(lines.findIndex(line => line.endsWith('Request received'))).toBeLessThan(lines.findIndex(line => line.endsWith('Prompt sent')));
	});

	it('logs what a chat request carried, how large it was, and how long reading it took', async () => {
		const lines: Array<{ message: string; level: string | undefined }> = [];
		const { url } = await boot({ log: (message, level) => { lines.push({ message, level }); } });
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, chat(model));

		expect(response.status).toBe(200);
		const line = lines.find(entry => entry.message.startsWith('Chat request: '));
		expect(line?.level).toBe('debug');
		expect(line?.message).toContain(`model ${model}, 1 message(s), `);
		expect(line?.message).toMatch(/, \d+\.\d KB, read in \d+ ms$/);
	});

	it('starts every enabled agent on request, without waiting for them', async () => {
		const url = await start();

		const response = await post(`${url}/v1/warm`);

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ agents: [adapter.id] });
	});

	it('starts the agent once, in its own folder, whatever folder a chat belongs to', async () => {
		const lines: string[] = [];
		const { url } = await boot({ log: message => { lines.push(message); } });
		const model = await firstModel(url);
		const folders = ['a', 'b'].map(name => fs.mkdtempSync(path.join(os.tmpdir(), `acp-hub-two-${name}-`)));
		cleanups.push(async () => {
			for (const folder of folders) {
				try {
					fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
				} catch {
					// Left to the temp folder's own clean-up.
				}
			}
		});

		for (const [index, folder] of folders.entries()) {
			const response = await post(`${url}/v1/chat/completions`, chat(model, `hello from folder ${index}`), { 'x-acp-cwd': folder });
			expect(response.status).toBe(200);
		}

		const started = lines.filter(line => line.includes('Started the agent in'));
		expect(started).toHaveLength(1);
		expect(started[0].replace(/\\/g, '/')).toContain('/agent/workspace');
	});

	it('does not warm an agent that is turned off', async () => {
		const { url, host } = await boot();
		await host.writeSetting(settingKey(adapter.id, 'enabled'), false);

		const response = await post(`${url}/v1/warm`);

		expect(await response.json()).toEqual({ agents: [] });
	});

	it('ends the response on the tool call the client has to run', async () => {
		const url = await start();
		const model = await firstModel(url);

		const body = await bodyOf(await post(`${url}/v1/chat/completions`, toolChat(model)));

		expect(body.choices[0].finish_reason).toBe('tool_calls');
		const calls = body.choices[0].message.tool_calls;
		expect(calls).toHaveLength(1);
		expect(calls[0].type).toBe('function');
		expect(calls[0].function.name).toBe('do_a_thing');
		expect(typeof calls[0].id).toBe('string');
	});

	it('continues the same turn when the client re-posts the tool result', async () => {
		const url = await start();
		const model = await firstModel(url);
		const first = await bodyOf(await post(`${url}/v1/chat/completions`, toolChat(model)));
		const toolCall = first.choices[0].message.tool_calls[0];

		const body = await bodyOf(await post(`${url}/v1/chat/completions`, {
			model,
			tools: [TOOL],
			messages: [
				{ role: 'user', content: 'tool' },
				{ role: 'assistant', content: null, tool_calls: [toolCall] },
				{ role: 'tool', tool_call_id: toolCall.id, content: 'the answer is 42' },
			],
		}));

		expect(body.choices[0].finish_reason).toBe('stop');
		expect(body.choices[0].message.content).toBe('tool:the answer is 42');
	});

	it('continues a turn that calls tools one after another, whose history keeps the settled results', async () => {
		const url = await start();
		const model = await firstModel(url);
		const ask = (messages: unknown[]): Promise<Response> => post(`${url}/v1/chat/completions`, { model, tools: [TOOL], messages });
		const user = { role: 'user', content: 'tool2' };
		const first = (await bodyOf(await ask([user]))).choices[0].message.tool_calls[0];
		const afterFirst = [user, { role: 'assistant', content: null, tool_calls: [first] }, { role: 'tool', tool_call_id: first.id, content: 'one' }];

		const second = (await bodyOf(await ask(afterFirst))).choices[0].message.tool_calls[0];
		const history = [...afterFirst, { role: 'assistant', content: null, tool_calls: [second] }, { role: 'tool', tool_call_id: second.id, content: 'two' }];
		const done = await bodyOf(await ask(history));

		expect(done.choices[0].finish_reason).toBe('stop');
		expect(done.choices[0].message.content).toBe('tool:two');
	});

	it('goes on in the same session when the client rewrites the result of a call it stopped waiting for', async () => {
		const logs: string[] = [];
		const url = await start({ log: message => logs.push(message) });
		const model = await firstModel(url);
		const ask = (messages: unknown[]): Promise<Response> => post(`${url}/v1/chat/completions`, { model, tools: [TOOL], messages });
		const user = { role: 'user', content: 'tool2' };
		const first = (await bodyOf(await ask([user]))).choices[0].message.tool_calls[0];
		const call = { role: 'assistant', content: null, tool_calls: [first] };
		// The second call is parked when the user stops the chat.
		await bodyOf(await ask([user, call, { role: 'tool', tool_call_id: first.id, content: 'one' }]));

		const body = await bodyOf(await ask([
			user,
			call,
			{ role: 'user', content: 'The result of the tool call arrived after this chat had stopped waiting for it: one' },
			{ role: 'user', content: 'continue' },
		]));

		expect(body.choices[0].message.content).toBe('hello');
		expect(logs.some(line => line.includes('left only tool results behind'))).toBe(true);
		expect(logs.some(line => line.includes('Chat history changed')), 'the chat was not treated as edited').toBe(false);
		// One session for the warm-up lookup and one for the chat; a rebuilt chat would open a third.
		expect(logs.filter(line => line.includes('Opened ACP session'))).toHaveLength(2);
	});

	it('refuses a tool result whose call no chat is waiting for', async () => {
		const url = await start();
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, {
			model,
			messages: [
				{ role: 'user', content: 'hi' },
				{ role: 'tool', tool_call_id: 'call-that-never-was', content: 'x' },
			],
		});

		expect(response.status).toBe(400);
		const body = await response.json() as any;
		expect(body.error.code).toBe('tool_call_not_found');
		expect(body.error.message).toContain('call-that-never-was');
	});

	it('keeps the parked calls of two chats apart', async () => {
		const url = await start();
		const model = await firstModel(url);
		const park = async (chatId: string): Promise<any> => {
			const body = await bodyOf(await post(`${url}/v1/chat/completions`, toolChat(model), { 'x-chat-id': chatId }));
			expect(body.choices[0].finish_reason).toBe('tool_calls');
			return body.choices[0].message.tool_calls[0];
		};
		const answer = (chatId: string, call: any, text: string): Promise<Response> => post(`${url}/v1/chat/completions`, {
			model,
			tools: [TOOL],
			messages: [
				{ role: 'user', content: 'tool' },
				{ role: 'assistant', content: null, tool_calls: [call] },
				{ role: 'tool', tool_call_id: call.id, content: text },
			],
		}, { 'x-chat-id': chatId });

		const callA = await park('chat-a');
		const callB = await park('chat-b');
		expect(callA.id).not.toBe(callB.id);

		// One chat cannot settle the other's call, and the refused request takes nothing with it.
		expect((await answer('chat-b', callA, 'wrong chat')).status).toBe(400);

		const answeredA = await bodyOf(await answer('chat-a', callA, 'a 42'));
		const answeredB = await bodyOf(await answer('chat-b', callB, 'b 42'));
		expect(answeredA.choices[0].message.content).toBe('tool:a 42');
		expect(answeredB.choices[0].message.content).toBe('tool:b 42');
	});

	it('answers a result whose call the client settled after the wait ran out, instead of losing it', async () => {
		const url = await start({ toolCallWaitMs: 300 });
		const model = await firstModel(url);
		const first = await bodyOf(await post(`${url}/v1/chat/completions`, toolChat(model)));
		const toolCall = first.choices[0].message.tool_calls[0];

		await new Promise(resolve => setTimeout(resolve, 700));
		const response = await post(`${url}/v1/chat/completions`, {
			model,
			tools: [TOOL],
			messages: [
				{ role: 'user', content: 'tool' },
				{ role: 'assistant', content: null, tool_calls: [toolCall] },
				{ role: 'tool', tool_call_id: toolCall.id, content: 'too late' },
			],
		});

		// The agent answers a new turn of the chat, as it does for any message the user sends.
		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.choices[0].finish_reason).toBe('stop');
		expect(body.choices[0].message.content).toBe('hello');
	});

	it('gives a parked call the wait the agent\'s own policy names, not one of the server\'s', async () => {
		// The mock agent's policy waits 200ms here: a result after that continues the chat afresh,
		// while a server that kept its own wait would still have continued the parked turn.
		const bounded: AgentAdapter = { ...adapter, sessionPolicy: { ...nativeSessionPolicy, toolWaitMs: () => 200 } };
		const url = await start({ adapter: bounded });
		const model = await firstModel(url);
		const first = await bodyOf(await post(`${url}/v1/chat/completions`, toolChat(model)));
		const toolCall = first.choices[0].message.tool_calls[0];

		await new Promise(resolve => setTimeout(resolve, 700));
		const answered = await bodyOf(await post(`${url}/v1/chat/completions`, {
			model,
			tools: [TOOL],
			messages: [
				{ role: 'user', content: 'tool' },
				{ role: 'assistant', content: null, tool_calls: [toolCall] },
				{ role: 'tool', tool_call_id: toolCall.id, content: 'too late' },
			],
		}));

		expect(answered.choices[0].message.content).toBe('hello');
	});

	describe('an agent the user disabled from the sidebar', () => {
		const listed = async (url: string): Promise<string[]> => {
			const body = await (await fetch(`${url}/v1/models`)).json() as { data: Array<{ id: string }> };
			return body.data.map(entry => entry.id).filter(id => id.startsWith(`${adapter.id}/`));
		};

		it('is not offered, and a chat with it is refused with the way to enable it', async () => {
			const { url, host } = await boot();
			await host.writeSetting(settingKey(adapter.id, 'enabled'), false);

			expect(await listed(url)).toEqual([]);

			const response = await post(`${url}/v1/chat/completions`, chat(`${adapter.id}/mock-1`));

			expect(response.status).toBe(404);
			const body = await response.json() as any;
			expect(body.error.code).toBe('model_not_found');
			expect(body.error.message).toContain('enable it from the ACP Hub sidebar');
		});

		it('is offered and answers again once the setting is turned back on, without a restart', async () => {
			const { url, host } = await boot();
			const model = await firstModel(url);
			await host.writeSetting(settingKey(adapter.id, 'enabled'), false);
			expect(await listed(url)).toEqual([]);

			await host.writeSetting(settingKey(adapter.id, 'enabled'), true);

			expect((await listed(url)).length).toBeGreaterThan(0);
			const response = await post(`${url}/v1/chat/completions`, chat(model));
			expect(response.status).toBe(200);
			expect((await response.json() as any).choices[0].message.content).toBe('hello');
		});
	});

	describe('the model list a BYOK client reads', () => {
		it('carries a created time that stays put', async () => {
			const url = await start();

			const first = await (await fetch(`${url}/v1/models`)).json() as any;
			const second = await (await fetch(`${url}/v1/models`)).json() as any;

			expect(first.data.length).toBeGreaterThan(0);
			for (const entry of first.data) {
				expect(Number.isInteger(entry.created)).toBe(true);
			}
			expect(second.data.map((entry: { created: number }) => entry.created)).toEqual(first.data.map((entry: { created: number }) => entry.created));
		});

		it('answers one model by an id that carries a slash of its own', async () => {
			const url = await start();
			const model = await firstModel(url);

			const response = await fetch(`${url}/v1/models/${model}`);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ id: model, object: 'model', created: expect.any(Number) });
		});

		it('answers the same model when its id arrives encoded', async () => {
			const url = await start();
			const model = await firstModel(url);

			const response = await fetch(`${url}/v1/models/${encodeURIComponent(model)}`);

			expect(response.status).toBe(200);
			expect((await response.json() as any).id).toBe(model);
		});

		it('answers an unknown model id with a 404 in the OpenAI error shape', async () => {
			const url = await start();

			const response = await fetch(`${url}/v1/models/mock/nothing-here`);

			expect(response.status).toBe(404);
			const body = await response.json() as any;
			expect(body.error.code).toBe('model_not_found');
			expect(body.error.param).toBeNull();
		});
	});

	describe('the routes a BYOK client may send', () => {
		it('answers the unversioned aliases and a trailing slash', async () => {
			const url = await start();
			const model = await firstModel(url);

			const models = await fetch(`${url}/models/`);
			const completion = await post(`${url}/chat/completions`, chat(model));

			expect(models.status).toBe(200);
			expect((await models.json() as any).object).toBe('list');
			expect(completion.status).toBe(200);
			expect((await completion.json() as any).choices[0].message.content).toBe('hello');
		});

		it('answers a known route sent the wrong method with a 405 and the method it takes', async () => {
			const url = await start();

			const listed = await post(`${url}/v1/models`);
			const chatted = await fetch(`${url}/v1/chat/completions`);

			expect(listed.status).toBe(405);
			expect(listed.headers.get('allow')).toBe('GET');
			expect((await listed.json() as any).error.code).toBe('method_not_allowed');
			expect(chatted.status).toBe(405);
			expect(chatted.headers.get('allow')).toBe('POST');
		});

		it('answers a preflight before it asks for the token, and lets any origin read the /v1 routes', async () => {
			const url = await start({ token: 'secret' });

			const preflight = await fetch(`${url}/v1/chat/completions`, {
				method: 'OPTIONS',
				headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'POST' },
			});
			const listed = await fetch(`${url}/v1/models`, { headers: { Authorization: 'Bearer secret' } });

			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
			expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
			expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Chat-Id');
			expect(listed.headers.get('access-control-allow-origin')).toBe('*');
		});
	});

	describe('a turn that fails', () => {
		const LOST = 'The agent lost its connection.';

		it('answers a non-stream turn whose error event fired with a 500 OpenAI error', async () => {
			const { response } = await ask({}, [{ type: 'error', message: LOST }]);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: { message: LOST, type: 'server_error', code: 'engine_error', param: null } });
		});

		it('ends a stream that failed with one error chunk and [DONE], and no finish', async () => {
			const { response } = await ask({ stream: true }, [{ type: 'error', message: LOST }]);
			expect(response.status).toBe(200);

			const text = await response.text();
			const chunks = chunksOf(text);

			expect(payloadsOf(text).at(-1)).toBe('[DONE]');
			expect(chunks.at(-1).error).toEqual({ message: LOST, type: 'server_error', code: 'engine_error', param: null });
			expect(chunks.some(chunk => (chunk.choices ?? []).some((choice: { finish_reason: unknown }) => choice.finish_reason !== null))).toBe(false);
		});

		it('ends a stream whose turn threw the same way', async () => {
			const { response } = await ask({ stream: true }, () => { throw new Error('The engine broke.'); });

			const chunks = chunksOf(await response.text());

			expect(chunks.at(-1).error).toEqual({ message: 'The engine broke.', type: 'server_error', code: 'engine_error', param: null });
			expect(chunks.some(chunk => chunk.choices?.[0]?.finish_reason)).toBeFalsy();
		});
	});

	describe('the finish reason and the usage of a stream', () => {
		const streamed = async (body: Record<string, unknown>, events: StreamEvent[]): Promise<any[]> => {
			const { response } = await ask({ stream: true, ...body }, events);
			expect(response.status).toBe(200);
			return chunksOf(await response.text());
		};

		it('says tool_calls whenever the turn called a tool, whatever its stop reason', async () => {
			const chunks = await streamed({}, [{ type: 'tool-call', callId: 'call-1', name: 'do_a_thing', input: {} }, { type: 'done', stopReason: 'end_turn' }]);

			expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
		});

		it('says length for a turn the token limit ended', async () => {
			const chunks = await streamed({}, [{ type: 'text', text: 'half' }, { type: 'done', stopReason: 'max_tokens' }]);

			expect(chunks.at(-1).choices[0].finish_reason).toBe('length');
		});

		it('carries the usage in a final chunk only when stream_options asks for it', async () => {
			const events: StreamEvent[] = [
				{ type: 'text', text: 'hello' },
				{ type: 'usage', promptTokens: 3, cachedTokens: 0, outputTokens: 2 },
				{ type: 'done', stopReason: 'end_turn' },
			];

			const plain = await streamed({}, events);
			const asked = await streamed({ stream_options: { include_usage: true } }, events);

			expect(plain.some(chunk => 'usage' in chunk)).toBe(false);
			const finish = asked.at(-2);
			expect(finish.choices[0].finish_reason).toBe('stop');
			expect('usage' in finish).toBe(false);
			expect(asked.at(-1).choices).toEqual([]);
			expect(asked.at(-1).usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
		});
	});

	describe('what a body asks of the reply', () => {
		const FENCED = [{ type: 'text', text: '```json\n{"answer": 42}\n```' }] as StreamEvent[];

		it('tells the agent to answer with JSON only, and unwraps a fenced answer', async () => {
			const plain = await ask({}, FENCED);
			const json = await ask({ response_format: { type: 'json_object' } }, FENCED);

			expect(plain.requests[0].systemGuidance).toBeUndefined();
			expect((await plain.response.json() as any).choices[0].message.content).toContain('```');
			expect(json.requests[0].systemGuidance).toContain('ONLY a single valid JSON value');
			expect((await json.response.json() as any).choices[0].message.content).toBe('{"answer": 42}');
		});

		it('carries the schema of a json_schema reply into the guidance', async () => {
			const { requests } = await ask({ response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', required: ['answer'] } } } });

			expect(requests[0].systemGuidance).toContain('"required":["answer"]');
		});

		it('keeps the client\'s own guidance before what it appends', async () => {
			const { requests } = await ask({ messages: [{ role: 'system', content: 'Work in the open folder.' }, { role: 'user', content: 'hi' }], response_format: { type: 'json_object' } });

			expect(requests[0].systemGuidance).toContain('Work in the open folder.');
			expect(requests[0].systemGuidance).toContain('ONLY a single valid JSON value');
		});

		it('tells the agent to call a tool when tool_choice is required', async () => {
			const { requests } = await ask({ tools: [TOOL], tool_choice: 'required' });

			expect(requests[0].systemGuidance).toContain('must call one of the tools');
			expect(requests[0].tools.map(tool => tool.name)).toEqual(['do_a_thing']);
		});

		it('reads the legacy functions and function_call as tools and a choice', async () => {
			const { requests } = await ask({
				functions: [
					{ name: 'do_a_thing', description: 'Answers a question.', parameters: { type: 'object' } },
					{ name: 'other', description: '', parameters: { type: 'object' } },
				],
				function_call: { name: 'do_a_thing' },
			});

			expect(requests[0].tools.map(tool => tool.name)).toEqual(['do_a_thing']);
		});

		it('refuses a request for more than one choice', async () => {
			const { response } = await ask({ n: 2 });

			expect(response.status).toBe(400);
			const body = await response.json() as any;
			expect(body.error.code).toBe('unsupported_parameter');
			expect(body.error.message).toContain('"n"');
		});
	});

	it('reads a legacy function message as the result of the call it names', async () => {
		const url = await start();
		const model = await firstModel(url);
		const first = await bodyOf(await post(`${url}/v1/chat/completions`, toolChat(model)));
		const toolCall = first.choices[0].message.tool_calls[0];

		const body = await bodyOf(await post(`${url}/v1/chat/completions`, {
			model,
			tools: [TOOL],
			messages: [
				{ role: 'user', content: 'tool' },
				{ role: 'assistant', content: null, tool_calls: [toolCall] },
				{ role: 'function', name: toolCall.id, content: 'the answer is 42' },
			],
		}));

		expect(body.choices[0].finish_reason).toBe('stop');
		expect(body.choices[0].message.content).toBe('tool:the answer is 42');
	});

	it('tells the agent about each attachment it cannot read, and keeps an inline image', async () => {
		const { requests } = await ask({
			messages: [{
				role: 'user',
				content: [
					{ type: 'text', text: 'look' },
					{ type: 'image_url', image_url: { url: 'https://example.com/screen.png' } },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
					{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
					{ type: 'file', file: { filename: 'notes.pdf' } },
				],
			}],
		});

		expect(requests[0].messages[0].parts).toEqual([
			{ type: 'text', text: 'look' },
			{ type: 'text', text: '[An attachment of type image_url was omitted: the agent cannot read it.]' },
			{ type: 'image', mimeType: 'image/png', data: Buffer.from('AAAA', 'base64') },
			{ type: 'text', text: '[An attachment of type input_audio was omitted: the agent cannot read it.]' },
			{ type: 'text', text: '[An attachment of type file was omitted: the agent cannot read it.]' },
		]);
	});

	it('writes a keep-alive comment while a stream waits on its turn', async () => {
		const silent: AgentAdapter = { ...adapter, launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: 'slow' } }) };
		const { url } = await boot({ adapter: silent, streamKeepAliveMs: 50 });
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, { ...chat(model), stream: true });
		const reader = response.body!.getReader();
		const text = await readUntil(reader, ': keep-alive', 5_000);
		await reader.cancel();

		expect(text).toContain(': keep-alive');
	});

	it('guards every route but the health probe when a token is configured', async () => {
		const url = await start({ token: 'secret' });

		expect((await fetch(`${url}/health`)).status).toBe(200);
		expect((await fetch(`${url}/v1/models`)).status).toBe(401);
		const guarded = await post(`${url}/v1/chat/completions`, chat('mock/mock-1'));
		expect(guarded.status).toBe(401);
		expect((await guarded.json() as any).error.code).toBe('invalid_api_key');
		expect((await fetch(`${url}/v1/models`, { headers: { Authorization: 'Bearer secret' } })).status).toBe(200);
	});
});
