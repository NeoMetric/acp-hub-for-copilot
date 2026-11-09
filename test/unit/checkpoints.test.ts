/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AcpSessionUpdate } from '../../src/engine/acp/agentClient';
import { checkpointOf, countsOf, noteAgentUpdate, type AgentMessage } from '../../src/core/provider/checkpoints';
import { messageFingerprintOf } from '../../src/core/sessionStore';

const chunk = (text: string, messageId?: string): AcpSessionUpdate => ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
const toolCall: AcpSessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 't1' };

function messagesOf(...updates: AcpSessionUpdate[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const update of updates) {
		noteAgentUpdate(messages, update);
	}
	return messages;
}

describe('noteAgentUpdate', () => {
	it('puts the chunks of one message together', () => {
		expect(messagesOf(chunk('Hel', 'm1'), chunk('lo', 'm1'))).toEqual([{ id: 'm1', text: 'Hello', closed: false }]);
	});

	it('starts a message when the id changes', () => {
		expect(messagesOf(chunk('one', 'm1'), chunk('two', 'm2')).map(message => message.text)).toEqual(['one', 'two']);
	});

	it('starts a message after a tool call, for an agent that names none', () => {
		const messages = messagesOf(chunk('before'), toolCall, chunk('after'));
		expect(messages.map(message => message.text)).toEqual(['before', 'after']);
		expect(messages[0].closed).toBe(true);
	});

	it('ignores thoughts, empty chunks and other updates', () => {
		expect(messagesOf({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }, chunk(''), { sessionUpdate: 'usage_update' })).toEqual([]);
	});
});

describe('checkpointOf', () => {
	it('describes the last message of the turn', () => {
		const messages = messagesOf(chunk('first', 'm1'), toolCall, chunk('final', 'm2'));

		expect(checkpointOf(messages, new Map(), 5)).toEqual({ messages: 5, messageId: 'm2', fingerprint: messageFingerprintOf('final'), occurrence: 1, messageCounts: { [messageFingerprintOf('first')]: 1, [messageFingerprintOf('final')]: 1 } });
	});

	it('numbers a message that says what an earlier one said', () => {
		const counts = new Map<string, number>();
		checkpointOf(messagesOf(chunk('Done.', 'a')), counts, 3);

		expect(checkpointOf(messagesOf(chunk('Done.', 'b')), counts, 5)?.occurrence).toBe(2);
		expect(checkpointOf(messagesOf(chunk('Done.', 'c'), toolCall, chunk('Done.', 'd')), counts, 7)?.occurrence).toBe(4);
	});

	it('records nothing when the turn ended on a tool call or said nothing', () => {
		expect(checkpointOf(messagesOf(chunk('text', 'm1'), toolCall), new Map(), 3)).toBeUndefined();
		expect(checkpointOf([], new Map(), 3)).toBeUndefined();
		expect(checkpointOf(messagesOf(chunk('  \n', 'm1')), new Map(), 3)).toBeUndefined();
	});

	it('names a message for an agent that sent no id, and finds it by its fingerprint', () => {
		const checkpoint = checkpointOf(messagesOf(chunk('answer')), new Map(), 3);

		expect(checkpoint?.messageId).toMatch(/^acp-hub-[0-9a-f]{12}-1$/);
		expect(checkpoint?.fingerprint).toBe(messageFingerprintOf('answer'));
	});
});

describe('countsOf', () => {
	it('restores the occurrence number, including earlier non-final messages and pruned checkpoints', () => {
		const fingerprint = messageFingerprintOf('Done.');
		const counts = countsOf([{ messages: 5, messageId: 'a', fingerprint, occurrence: 4 }]);
		expect(checkpointOf(messagesOf(chunk('Done.', 'b')), counts, 7)?.occurrence).toBe(5);
	});

	it('restores intermediate messages when continuing from a saved checkpoint', () => {
		const counts = new Map<string, number>();
		const saved = checkpointOf(messagesOf(chunk('Done.'), toolCall, chunk('other')), counts, 3)!;
		const resumed = countsOf([saved]);
		expect(checkpointOf(messagesOf(chunk('Done.')), resumed, 5)?.occurrence).toBe(2);
	});

	it('counts the checkpoints of each fingerprint', () => {
		const one = { messages: 3, messageId: 'a', fingerprint: 'sha256:1', occurrence: 1 };
		const counts = countsOf([one, { ...one, messages: 5, occurrence: 2 }, { ...one, fingerprint: 'sha256:2' }]);

		expect(counts.get('sha256:1')).toBe(2);
		expect(counts.get('sha256:2')).toBe(1);
	});
});
