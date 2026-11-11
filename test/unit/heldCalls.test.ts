import { describe, expect, it, vi } from 'vitest';
import { resolveToolResults } from '../../src/engine/chat/heldCalls';
import type { ActiveTurn } from '../../src/engine/chat/types';
import type { ChatMessage, Part } from '../../src/engine/model/chat';

const message = (role: ChatMessage['role'], ...parts: Array<string | Part>): ChatMessage => ({
	role,
	parts: parts.map(part => typeof part === 'string' ? { type: 'text', text: part } : part),
});

describe('tool result continuation', () => {
	it('delivers separate skill context with the tool result without duplicating it', () => {
		for (const alreadyIncluded of [false, true]) {
			const context = '<skill-context name="test">instructions</skill-context>';
			const content: Part[] = [{ type: 'text', text: alreadyIncluded ? context : 'loaded' }];
			const result: Part = { type: 'tool-result', callId: '1', content };
			let received: readonly Part[] = [];
			const turn = { pending: new Map([['1', { resolve: (parts: readonly Part[]) => { received = parts; }, reject: vi.fn() }]]), streaming: false } as unknown as ActiveTurn;
			resolveToolResults(turn, [message('assistant', { type: 'tool-call', callId: '1', name: 'skill', input: {} }), message('user', result), message('user', context)], vi.fn());
			expect(received.filter(part => part.type === 'text' && part.text === context)).toHaveLength(1);
		}
	});
});
