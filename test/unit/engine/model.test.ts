import { describe, expect, it } from 'vitest';
import type { ChatRequest, Part } from '../../../src/engine/model/chat';
import type { StreamEvent } from '../../../src/engine/model/stream';

const image = new Uint8Array([137, 80, 78, 71]);

const everyPart: readonly Part[] = [
	{ type: 'text', text: 'What is in this picture?' },
	{ type: 'image', data: image, mimeType: 'image/png' },
	{ type: 'tool-call', callId: 'call-1', name: 'readFile', input: { path: 'a.txt' } },
	{ type: 'tool-result', callId: 'call-1', content: [{ type: 'text', text: 'hello' }], isError: false },
];

const request: ChatRequest = {
	chatId: 'chat-1',
	cwd: 'C:\\work',
	messages: [
		{ role: 'system', parts: [{ type: 'text', text: 'Be brief.' }] },
		{ role: 'user', parts: everyPart },
		{ role: 'tool', name: 'readFile', parts: [{ type: 'tool-result', callId: 'call-1', content: [{ type: 'text', text: 'hello' }] }] },
	],
	tools: [{ name: 'readFile', description: 'Reads a file.', inputSchema: { type: 'object' } }],
	model: 'claude-x',
	effort: 'high',
	systemGuidance: 'Prefer small diffs.',
};

describe('the chat model', () => {
	it('carries every kind of part through a copy unchanged', () => {
		const copy = structuredClone(request);

		expect(copy).toEqual(request);
		expect(copy.messages[1].parts.map(part => part.type)).toEqual(['text', 'image', 'tool-call', 'tool-result']);
		expect(copy.messages[1].parts[1]).toEqual({ type: 'image', data: image, mimeType: 'image/png' });
	});
});

describe('the stream model', () => {
	it('expresses every event of a turn', () => {
		const events: readonly StreamEvent[] = [
			{ type: 'text', text: 'Hello' },
			{ type: 'thought', text: 'Consider the question.' },
			{ type: 'tool-call', callId: 'call-1', name: 'readFile', input: { path: 'a.txt' } },
			{ type: 'usage', promptTokens: 120, cachedTokens: 80, outputTokens: 30 },
			{ type: 'done', stopReason: 'end_turn' },
			{ type: 'error', message: 'The agent stopped.' },
		];

		expect(events.map(event => event.type)).toEqual(['text', 'thought', 'tool-call', 'usage', 'done', 'error']);
	});
});
