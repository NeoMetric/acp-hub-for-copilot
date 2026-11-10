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
import type { Part } from '../../src/engine/model/chat';
import { settingKey } from '../../src/core/settings';
import { createHeadlessHost, type HeadlessHost } from '../../src/hosts/http/host';
import { createServer } from '../../src/hosts/http/server';

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
	readonly adapter?: AgentAdapter;
	/** Sees every line the server logs. */
	readonly log?: (message: string) => void;
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
	const service = new ChatService({
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
	const server = createServer({ composition, token: options.token, toolCallWaitMs: options.toolCallWaitMs });
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
