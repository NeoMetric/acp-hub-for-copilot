/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildPromptBlocks } from '../../src/engine/chat/assemble';
import { DEFAULT_TRANSCRIPT_OPTIONS, lastUserMessageIndex } from '../../src/engine/chat/messages';
import type { ChatSession } from '../../src/engine/chat/types';
import type { ChatMessage, Part } from '../../src/engine/model/chat';

const session = {} as ChatSession;
const log = () => undefined;

const message = (role: ChatMessage['role'], ...parts: Array<string | Part>): ChatMessage => ({
	role,
	parts: parts.map(part => typeof part === 'string' ? { type: 'text', text: part } : part),
});
const user = (...parts: Array<string | Part>) => message('user', ...parts);
const assistant = (...parts: Array<string | Part>) => message('assistant', ...parts);
const toolCall = (callId: string, name: string): Part => ({ type: 'tool-call', callId, name, input: {} });
const toolResult = (callId: string): Part => ({ type: 'tool-result', callId, content: [{ type: 'text', text: 'output' }] });

/** The prompt for a session whose cursor stands after `seen` messages. */
function promptAfter(seen: number, messages: ChatMessage[]) {
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

describe('buildPromptBlocks with what the host contributes', () => {
	// The engine names no section of any host's prompt: the host hands over the
	// context it holds and the way to take its own sections out of a message.
	const hostPrompt = {
		chatContext: '<host_context>this machine</host_context>',
		stripHostSections: (text: string) => text.replace(/<host_context>[\s\S]*?<\/host_context>/g, ''),
	};

	it('forwards the context of the chat once, ahead of the transcript', () => {
		const messages = [user('<host_context>this machine</host_context>'), user('1'), user('2')];

		const blocks = buildPromptBlocks(messages, 2, 2, true, session, log, DEFAULT_TRANSCRIPT_OPTIONS, hostPrompt);

		expect(blocks[0]).toEqual({ type: 'text', text: hostPrompt.chatContext });
		expect((blocks[1] as { text: string }).text).toContain('<conversation_so_far>');
		expect(blocks[2]).toEqual({ type: 'text', text: '2' });
	});

	it('takes the host\'s sections out of the text it forwards', () => {
		const messages = [user('<host_context>this machine</host_context>\nwhat changed?')];

		const blocks = buildPromptBlocks(messages, 0, 0, false, session, log, DEFAULT_TRANSCRIPT_OPTIONS, hostPrompt);

		expect(blocks).toEqual([{ type: 'text', text: 'what changed?' }]);
	});
});
