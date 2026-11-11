/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listModels, ServerChatError, streamChat, type WireEvent } from '../../src/hosts/vscode/serverClient';
import type { ServerEndpoint } from '../../src/hosts/vscode/serverLink';

const servers: http.Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

/** A loopback server that answers the way the test writes it, and the endpoint that reaches it. */
async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<ServerEndpoint> {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** One SSE chunk, as the server writes it. */
function send(response: http.ServerResponse, value: unknown): void {
	response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: 'chatcmpl-1',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'claude/sonnet',
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

/** The final chunk of a turn whose client asked for its figures: no choices, as OpenAI sends it. */
function usageChunk(usage: unknown): unknown {
	return {
		id: 'chatcmpl-1',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'claude/sonnet',
		choices: [],
		usage,
	};
}

/** Reads a whole stream, keeping the events it reported. */
async function eventsOf(endpoint: ServerEndpoint, signal = new AbortController().signal): Promise<WireEvent[]> {
	const events: WireEvent[] = [];
	await streamChat(endpoint, { model: 'claude/sonnet' }, signal, event => events.push(event));
	return events;
}

describe('streamChat', () => {
	it('assembles the streamed arguments of each tool call by its index', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			send(response, chunk({ role: 'assistant' }));
			send(response, chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }));
			send(response, chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'list', arguments: '{}' } }] }));
			send(response, chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }));
			send(response, chunk({}, 'tool_calls'));
			response.write('data: [DONE]\n\n');
			response.end();
		});

		expect(await eventsOf(endpoint)).toEqual([
			{ type: 'tool-call', callId: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
			{ type: 'tool-call', callId: 'call_2', name: 'list', input: {} },
		]);
	});

	it('reports thinking apart from the answer, and the usage of a final chunk with no choices', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			send(response, chunk({ role: 'assistant' }));
			send(response, chunk({ reasoning_content: 'weighing it' }));
			send(response, chunk({ content: 'the answer' }));
			send(response, chunk({}, 'stop'));
			send(response, usageChunk({
				prompt_tokens: 12,
				completion_tokens: 3,
				total_tokens: 15,
				prompt_tokens_details: { cached_tokens: 4 },
				completion_tokens_details: { reasoning_tokens: 2 },
			}));
			response.write('data: [DONE]\n\n');
			response.end();
		});

		expect(await eventsOf(endpoint)).toEqual([
			{ type: 'thought', text: 'weighing it' },
			{ type: 'text', text: 'the answer' },
			{
				type: 'usage',
				usage: {
					prompt_tokens: 12,
					completion_tokens: 3,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 4 },
					completion_tokens_details: { reasoning_tokens: 2 },
				},
			},
		]);
	});

	it('aborts the request when the signal fires, and resolves without an error', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			send(response, chunk({ content: 'first' }));
			// The reply is never finished: the window leaves instead.
		});
		const controller = new AbortController();
		const events: WireEvent[] = [];

		await streamChat(endpoint, { model: 'claude/sonnet' }, controller.signal, event => {
			events.push(event);
			controller.abort();
		});

		expect(events).toEqual([{ type: 'text', text: 'first' }]);
	});

	it('rejects with a readable message when the connection is reset mid-stream', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			send(response, chunk({ content: 'half an ans' }));
			setTimeout(() => response.destroy(), 5);
		});

		const failure = await eventsOf(endpoint).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ServerChatError);
		const message = (failure as Error).message;
		expect(message).toContain(`The server at ${endpoint.baseUrl}`);
		expect(message).toMatch(/ended the reply before it finished/);
	});

	it('rejects when the stream ends without [DONE]', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			send(response, chunk({ content: 'partial' }));
			response.end();
		});

		await expect(eventsOf(endpoint)).rejects.toThrow(/ended the reply before it finished/);
	});

	it('rejects a stream that names its finish reason but is then cut before [DONE]', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			send(response, chunk({ content: 'done' }));
			send(response, chunk({}, 'stop'));
			response.end();
		});

		await expect(eventsOf(endpoint)).rejects.toThrow(/ended the reply before it finished/);
	});

	it('names the token, and never prints it, when the server refuses it', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(401, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: { message: 'unauthorized: bad bearer token', type: 'invalid_request_error', code: 'unauthorized' } }));
		});

		const failure = await eventsOf({ ...endpoint, token: 'a-secret-token' }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ServerChatError);
		const message = (failure as Error).message;
		expect(message).toContain(endpoint.baseUrl);
		expect(message).toMatch(/401/);
		expect(message).toMatch(/token/i);
		expect(message).not.toContain('a-secret-token');
	});

	it('throws the server\'s error when the reply is one error chunk and no finish', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			send(response, { error: { message: 'The agent stopped.', type: 'server_error', code: 'engine_error', param: null } });
			response.write('data: [DONE]\n\n');
			response.end();
		});

		const failure = await eventsOf(endpoint).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ServerChatError);
		expect((failure as Error).message).toBe('The agent stopped.');
	});
});

describe('listModels', () => {
	it('lists the models of the server with the bearer token it was given', async () => {
		let authorization: string | undefined;
		const endpoint = await serve((request, response) => {
			authorization = request.headers.authorization;
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({
				object: 'list',
				data: [{
					id: 'claude/sonnet',
					object: 'model',
					owned_by: 'claude',
					acp: { name: 'Sonnet', family: 'claude', version: '1', maxInputTokens: 10, maxOutputTokens: 5, toolCalling: true, imageInput: true, efforts: [] },
				}],
			}));
		});

		const models = await listModels({ ...endpoint, token: 'test-token' });

		expect(authorization).toBe('Bearer test-token');
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe('claude/sonnet');
		expect(models[0].acp?.name).toBe('Sonnet');
	});

	it('rejects with a readable message when the server refuses the token', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(401, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: { message: 'unauthorized', type: 'invalid_request_error', code: 'unauthorized' } }));
		});

		await expect(listModels(endpoint)).rejects.toThrow(/HTTP 401/);
	});

	it('rejects with a readable message when nothing answers', async () => {
		const endpoint = await serve((_request, response) => {
			response.writeHead(503, { 'Content-Type': 'text/plain' });
			response.end('starting');
		});

		await expect(listModels(endpoint)).rejects.toThrow(/503/);
	});
});

describe('the server client', () => {
	it('talks HTTP alone, without the editor API', () => {
		const source = readFileSync('src/hosts/vscode/serverClient.ts', 'utf8');

		expect(source).not.toMatch(/from 'vscode'/);
	});
});
