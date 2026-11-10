/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from '../../../src/engine/chat/ChatService';
import type { ChatRequest } from '../../../src/engine/model/chat';
import type { StreamEvent } from '../../../src/engine/model/stream';
import { closeServers, start } from './serverHarness';

afterEach(async () => {
	vi.restoreAllMocks();
	await closeServers();
});

/** One OpenAI chat request, as a stock client writes it. */
function chat(model: string, text = 'hi'): Record<string, unknown> {
	return { model, messages: [{ role: 'user', content: text }] };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
}

/** The first model the mock agent offers, as the endpoint publishes it. */
async function firstModel(url: string): Promise<string> {
	const response = await fetch(`${url}/v1/models`);
	const body = await response.json() as { data: Array<{ id: string }> };
	const model = body.data.find(entry => entry.id.startsWith('mock/'));
	expect(model, 'the mock agent offers a model').toBeDefined();
	return model!.id;
}

/** The `data:` payloads of an SSE response, in order. */
function payloadsOf(text: string): string[] {
	return text.split('\n\n')
		.map(part => part.trim())
		.filter(part => part.startsWith('data:'))
		.map(part => part.slice('data:'.length).trim());
}

/** The tool the engine is told the client offers, so a call can be parked on it. */
const TOOL = {
	type: 'function',
	function: { name: 'do_a_thing', description: 'Answers a question.', parameters: { type: 'object', properties: { answer: { type: 'number' } } } },
};

/**
 * Replaces the engine with a recorder: what each request was handed is kept,
 * and the response is written from the events the test names for it.
 */
function recordEngine(eventsOf: (index: number) => StreamEvent[]): ChatRequest[] {
	const requests: ChatRequest[] = [];
	vi.spyOn(ChatService.prototype, 'respond').mockImplementation(async (request, sink) => {
		requests.push(request);
		for (const event of eventsOf(requests.length - 1)) {
			sink(event);
		}
	});
	return requests;
}

/** A turn that answers "ok" and ends, which is all a request-shape test needs. */
function plainTurn(): StreamEvent[] {
	return [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }];
}

/** A `data:` URL of `bytes` bytes, as a client that pasted an image sends it. */
function dataUrl(mimeType: string, bytes: number): string {
	return `data:${mimeType};base64,${Buffer.alloc(bytes, 7).toString('base64')}`;
}

describe('the chat wire', () => {
	it('names the chat, folder, folders, label, guidance and context from the acp extras', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		const requests = recordEngine(plainTurn);
		// A Windows profile with a space and non-ASCII letters: a header would mangle it.
		const cwd = 'C:\\Users\\Ünal Ö\\my repo';

		const response = await post(`${server.url}/v1/chat/completions`, {
			...chat(model),
			acp: {
				chatId: 'chat-from-extras',
				cwd,
				workspaceFolders: ['C:\\work\\one', 'C:\\work\\two'],
				label: 'A named chat',
				systemGuidance: 'Follow the rules of the repository.',
				chatContext: '<environment_info>Windows</environment_info>',
			},
		});

		expect(response.status).toBe(200);
		const request = requests[0];
		expect(request.chatId).toBe('chat-from-extras');
		expect(request.cwd).toBe(cwd);
		expect(request.systemGuidance).toBe('Follow the rules of the repository.');
		const identity = server.host.chatIdentity(request);
		expect(identity.id).toBe('chat-from-extras');
		expect(identity.cwd).toBe(cwd);
		expect(identity.workspaceFolders).toEqual(['C:\\work\\one', 'C:\\work\\two']);
		expect(identity.label).toBe('A named chat');
		expect(server.host.guidanceOf(request)).toBe('Follow the rules of the repository.');
		// The engine asks with a slice of the messages, so the context must survive one.
		expect(server.host.chatWideContextOf(request.messages)).toBe('<environment_info>Windows</environment_info>');
		expect(server.host.chatWideContextOf(request.messages.slice(0, 1))).toBe('<environment_info>Windows</environment_info>');
	});

	it('takes the system message of a stock client as its guidance, and the extension\'s own acp guidance over it', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		const requests = recordEngine(plainTurn);
		const system = { role: 'system', content: 'The user\'s workspace folder is C:\\work\\one.' };
		const developer = { role: 'developer', content: 'Prefer small diffs.' };
		const user = { role: 'user', content: 'hi' };

		await post(`${server.url}/v1/chat/completions`, { model, messages: [system, developer, user] });
		await post(`${server.url}/v1/chat/completions`, { model, messages: [system, user], acp: { systemGuidance: 'from the extension' } });
		await post(`${server.url}/v1/chat/completions`, { model, messages: [system, user], acp: { chatId: 'x' } });
		await post(`${server.url}/v1/chat/completions`, { model, messages: [user] });

		expect(requests[0].systemGuidance).toBe('The user\'s workspace folder is C:\\work\\one.\n\nPrefer small diffs.');
		expect(requests[1].systemGuidance).toBe('from the extension');
		expect(requests[2].systemGuidance, 'the extension may send no guidance on purpose').toBeUndefined();
		expect(requests[3].systemGuidance).toBeUndefined();
	});

	it('lets acp.chatId win over the x-chat-id header', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		const requests = recordEngine(plainTurn);

		await post(`${server.url}/v1/chat/completions`, { ...chat(model), acp: { chatId: 'from-extras' } }, { 'x-chat-id': 'from-header' });

		expect(requests[0].chatId).toBe('from-extras');
	});

	it('keys the engine session on acp.sessionKey and the chat figures on acp.chatId', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		const requests = recordEngine(plainTurn);

		await post(`${server.url}/v1/chat/completions`, { ...chat(model), acp: { chatId: 'one-chat', sessionKey: 'session-a' } });

		expect(requests[0].chatId).toBe('session-a');
		expect(server.host.chatIdentity(requests[0]).id).toBe('one-chat');
	});

	it('gives two sub-agents of one chat sessions of their own', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		const requests = recordEngine(plainTurn);

		await post(`${server.url}/v1/chat/completions`, { ...chat(model), acp: { chatId: 'one-chat', sessionKey: 'opening-a' } });
		await post(`${server.url}/v1/chat/completions`, { ...chat(model), acp: { chatId: 'one-chat', sessionKey: 'opening-b' } });

		expect(requests.map(request => request.chatId)).toEqual(['opening-a', 'opening-b']);
		expect(requests.map(request => server.host.chatIdentity(request).id)).toEqual(['one-chat', 'one-chat']);
	});

	it('settles a parked tool call across the requests of a turn by its session key', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		recordEngine(index => index === 0
			? [{ type: 'tool-call', callId: 'call-1', name: 'do_a_thing', input: { answer: 42 } }]
			: plainTurn());
		const asked = await post(`${server.url}/v1/chat/completions`, { ...chat(model, 'tool'), tools: [TOOL], acp: { chatId: 'one-chat', sessionKey: 'session-a' } });
		const call = (await asked.json() as any).choices[0].message.tool_calls[0];
		expect(call).toBeDefined();
		const answer = (sessionKey: string, text: string): Promise<Response> => post(`${server.url}/v1/chat/completions`, {
			model,
			tools: [TOOL],
			acp: { chatId: 'one-chat', sessionKey },
			messages: [
				{ role: 'user', content: 'tool' },
				{ role: 'assistant', content: null, tool_calls: [call] },
				{ role: 'tool', tool_call_id: call.id, content: text },
			],
		});

		// Another session of the same chat cannot settle this call...
		expect((await answer('session-b', 'wrong session')).status).toBe(400);
		// ...and the session that parked it can, on the request that follows it.
		expect((await answer('session-a', 'a 42')).status).toBe(200);
	});

	it('still names a chat no client names, from its folder and opening', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		const requests = recordEngine(plainTurn);

		await post(`${server.url}/v1/chat/completions`, chat(model));
		await post(`${server.url}/v1/chat/completions`, chat(model, 'other'));

		expect(requests[0].chatId).not.toBe('');
		expect(requests[0].chatId).not.toBe(requests[1].chatId);
		expect(requests[0].cwd).not.toBe('');
	});

	it('carries reasoning_effort to the engine as the effort of the turn', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		const requests = recordEngine(plainTurn);

		await post(`${server.url}/v1/chat/completions`, { ...chat(model), reasoning_effort: 'high' });

		expect(requests[0].effort).toBe('high');
	});

	it('carries a large pasted image to the engine as an image part, in user and tool messages', async () => {
		const server = await start();
		const model = await firstModel(server.url);
		// Ten megabytes of pixels, as base64, in the JSON body rather than a header.
		const pasted = dataUrl('image/png', 10 * 1024 * 1024);
		const screenshot = dataUrl('image/jpeg', 64);
		const requests = recordEngine(index => index === 0
			? [{ type: 'tool-call', callId: 'call-1', name: 'do_a_thing', input: { answer: 42 } }]
			: plainTurn());
		const look = { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: pasted } }] };

		const asked = await post(`${server.url}/v1/chat/completions`, { model, tools: [TOOL], messages: [look] });
		expect(asked.status).toBe(200);
		const call = (await asked.json() as any).choices[0].message.tool_calls[0];
		expect(call).toBeDefined();

		const answered = await post(`${server.url}/v1/chat/completions`, {
			model,
			tools: [TOOL],
			messages: [
				look,
				{ role: 'assistant', content: null, tool_calls: [call] },
				{ role: 'tool', tool_call_id: call.id, content: [{ type: 'text', text: 'the screenshot' }, { type: 'image_url', image_url: { url: screenshot } }] },
			],
		});
		expect(answered.status).toBe(200);

		const userImage = requests[0].messages[0].parts.find(part => part.type === 'image');
		expect(userImage).toMatchObject({ type: 'image', mimeType: 'image/png' });
		expect(userImage && userImage.type === 'image' ? userImage.data.length : 0).toBe(10 * 1024 * 1024);
		expect(requests[0].messages[0].parts.some(part => part.type === 'text' && part.text === 'what is this?')).toBe(true);

		const result = requests[1].messages.flatMap(message => message.parts).find(part => part.type === 'tool-result');
		expect(result).toBeDefined();
		const contents = result && result.type === 'tool-result' ? result.content : [];
		expect(contents.some(part => part.type === 'text' && part.text === 'the screenshot')).toBe(true);
		const toolImage = contents.find(part => part.type === 'image');
		expect(toolImage).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
		expect(toolImage && toolImage.type === 'image' ? toolImage.data.length : 0).toBe(64);
	});

	it('streams thinking as reasoning_content, and reports its tokens', async () => {
		const server = await start();
		const model = await firstModel(server.url);

		const response = await post(`${server.url}/v1/chat/completions`, { ...chat(model, 'think'), stream: true });

		expect(response.status).toBe(200);
		const chunks = payloadsOf(await response.text())
			.filter(payload => payload !== '[DONE]')
			.map(payload => JSON.parse(payload));
		expect(chunks.map(chunk => chunk.choices[0].delta.reasoning_content ?? '').join('')).toBe('pondering');
		expect(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join('')).toBe('hello');
		const last = chunks.at(-1);
		expect(last.choices[0].finish_reason).toBe('stop');
		expect(last.usage).toMatchObject({ completion_tokens_details: { reasoning_tokens: 7 } });
	});

	it('adds the thinking of a whole answer to its message', async () => {
		const server = await start();
		const model = await firstModel(server.url);

		const body = await (await post(`${server.url}/v1/chat/completions`, chat(model, 'think'))).json() as any;

		expect(body.choices[0].message.reasoning_content).toBe('pondering');
		expect(body.choices[0].message.content).toBe('hello');
		expect(body.usage).toMatchObject({ completion_tokens_details: { reasoning_tokens: 7 } });
	});

	it('answers a stock client that sends no extras', async () => {
		const server = await start();
		const model = await firstModel(server.url);

		const response = await post(`${server.url}/v1/chat/completions`, chat(model));
		const body = await response.json() as any;

		expect(response.status).toBe(200);
		expect(body.choices[0].message.content).toBe('hello');
	});
});
