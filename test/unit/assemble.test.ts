/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { lastUserMessageIndex } from '../../src/core/convert';
import { buildPromptBlocks } from '../../src/core/provider/assemble';
import type { ChatSession } from '../../src/core/provider/types';
import { assistant, toolCall, toolResult, user } from './messages';

const session = {} as ChatSession;
const log = () => undefined;

/** The prompt for a session whose cursor stands after `seen` messages. */
function promptAfter(seen: number, messages: ReturnType<typeof user>[]) {
	return buildPromptBlocks(messages, seen, lastUserMessageIndex(messages), false, session, log);
}

describe('buildPromptBlocks catching a session up', () => {
	it('sends only the new message when the session answered everything itself', () => {
		const messages = [user('1'), assistant('own reply'), user('2')];

		expect(promptAfter(1, messages)).toEqual([{ type: 'text', text: '2' }]);
	});

	it('catches up on the stretch another agent answered, then sends the new message', () => {
		// The session's cursor stands after message 1, and its own reply (index 1) follows it.
		const messages = [
			user('1'), assistant('claude reply'),
			user('2'), assistant('codex reply', toolCall('c', 'run')), user(toolResult('c')), assistant('codex done'),
			user('3'), assistant('codex reply 3'),
			user('4'),
		];

		const blocks = promptAfter(1, messages);

		expect(blocks).toHaveLength(2);
		const transcript = (blocks[0] as { text: string }).text;
		expect(transcript).toContain('<conversation_since_your_last_turn>');
		expect(transcript).toContain('User: 2');
		expect(transcript).toContain('Assistant: codex reply\n[called tools: run]');
		expect(transcript).toContain('Assistant: codex done');
		expect(transcript).toContain('User: 3');
		expect(transcript).toContain('Assistant: codex reply 3');
		expect(transcript).not.toContain('claude reply');
		expect(transcript).not.toContain('User: 4');
		expect(blocks[1]).toEqual({ type: 'text', text: '4' });
	});

	it('does not treat a tool-result message as something the user said', () => {
		const messages = [user('1'), assistant('looking', toolCall('c', 'run')), user(toolResult('c')), user('2')];

		expect(promptAfter(1, messages)).toEqual([{ type: 'text', text: '2' }]);
	});

	it('leaves a session that must restore its context to the existing transcript', () => {
		const messages = [user('1'), assistant('a'), user('2')];

		const blocks = buildPromptBlocks(messages, 2, 2, true, session, log);

		expect((blocks[0] as { text: string }).text).toContain('<conversation_so_far>');
		expect((blocks[0] as { text: string }).text).not.toContain('<conversation_since_your_last_turn>');
	});
});
