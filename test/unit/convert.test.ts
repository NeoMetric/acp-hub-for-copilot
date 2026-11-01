/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSCRIPT_OPTIONS, carriesToolResults, characterCountOf, chatContextBlock, customInstructionsBlock, diverged, fingerprint, firstMessageAfterReply, firstUserWordsIn, imageFingerprint, lastUserMessageIndex, textOf, toAcpContentBlocks, toTranscriptBlock, userWordsAfterReply } from '../../src/core/convert';
import { assistant, image, system, toolCall, toolResult, user } from './messages';
import { LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart } from './vscode-mock';

describe('textOf', () => {
	it('joins text parts and ignores the rest', () => {
		expect(textOf(user('one', image([1]), 'two'))).toBe('one\ntwo');
	});
});

describe('characterCountOf', () => {
	it('counts text, tool calls, tool results and images', () => {
		expect(characterCountOf(user('four'))).toBe(4);
		expect(characterCountOf(assistant('hi', toolCall('c1', 'run')))).toBe(2 + 'run'.length + '{}'.length);
		expect(characterCountOf(user(toolResult('c1')))).toBe('output'.length);
		expect(characterCountOf(user(image([1])))).toBeGreaterThan(1000);
	});
});

describe('toAcpContentBlocks', () => {
	it('forwards user text and images, skipping assistant messages and blank text', () => {
		const blocks = toAcpContentBlocks([
			user('hello', image([1, 2, 3])),
			assistant('an answer'),
			user('   '),
		]);

		expect(blocks).toEqual([
			{ type: 'text', text: 'hello' },
			{ type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
		]);
	});
});

describe('toAcpContentBlocks context stripping', () => {
	it('forwards the user request, its attachments and the state of the turn', () => {
		const blocks = toAcpContentBlocks([
			user('<context><current_datetime>now</current_datetime></context><attachments><attachment id="a">file</attachment></attachments><userRequest>fix it</userRequest>'),
		]);

		expect(blocks).toEqual([
			{ type: 'text', text: '<attachments><attachment id="a">file</attachment></attachments>\n\n<context><current_datetime>now</current_datetime></context>\n\nfix it' },
		]);
	});

	it('keeps the state of the turn, its reminders and the tools the user pointed at', () => {
		const turn = user([
			'<toolReferences>The user attached read_file to this message.</toolReferences>',
			'<notebookFormatInstructions>Use cell ids.</notebookFormatInstructions>',
			'<context>',
			'<current_datetime>2026-10-24T12:50:54.417+05:30</current_datetime>',
			'<editedFileEvents>edited src/a.ts</editedFileEvents>',
			'<todoList>- [ ] fix the bug</todoList>',
			'<terminalState>npm test is running</terminalState>',
			'</context>',
			'<editorContext>src/b.ts is open</editorContext>',
			'<reminderInstructions>Use the todo tool for every step.</reminderInstructions>',
			'<userRequest>continue</userRequest>',
		].join('\n'));

		const block = toAcpContentBlocks([turn])[0];
		const text = block?.type === 'text' ? block.text : '';

		expect(text).toContain('edited src/a.ts');
		expect(text).toContain('- [ ] fix the bug');
		expect(text).toContain('npm test is running');
		expect(text).toContain('src/b.ts is open');
		expect(text).toContain('Use the todo tool for every step.');
		expect(text).toContain('attached read_file');
		expect(text).toContain('Use cell ids.');
		expect(text).toContain('continue');
		expect(text.indexOf('2026-10-24')).toBeLessThan(text.indexOf('continue'));
	});

	it('still drops the context that describes the chat once, which the agent has its own of', () => {
		const text = toAcpContentBlocks([user(
			'<workspace_info>tree</workspace_info><userMemory>notes</userMemory><sessionMemory>x</sessionMemory><userRequest>go</userRequest>',
		)])[0];

		expect(text).toEqual({ type: 'text', text: 'go' });
	});
});

describe('toAcpContentBlocks context without a request', () => {
	it('drops a message that only carries Copilot context', () => {
		expect(toAcpContentBlocks([
			user('<environment_info>os</environment_info>\n<workspace_info>tree</workspace_info>\n<userMemory>notes</userMemory>'),
		])).toEqual([]);
	});

	it('keeps what the user wrote around the context', () => {
		expect(toAcpContentBlocks([
			user('fix this <environment_info>os</environment_info>'),
		])).toEqual([{ type: 'text', text: 'fix this' }]);
	});

	it('leaves ordinary text alone, whitespace included', () => {
		expect(toAcpContentBlocks([user('  keep my spacing  ')])).toEqual([{ type: 'text', text: '  keep my spacing  ' }]);
	});
});

describe('chatContextBlock', () => {
	it('forwards the context Copilot sends ahead of the first request', () => {
		const block = chatContextBlock([
			system('You are Copilot.'),
			user('<environment_info>Linux</environment_info>\n<workspace_info>tree</workspace_info>\n<userMemory>notes</userMemory>'),
			user('<context>now</context><userRequest>go</userRequest>'),
		]);

		expect(block).toEqual({
			type: 'text',
			text: '<environment_info>Linux</environment_info>\n\n<workspace_info>tree</workspace_info>\n\n<userMemory>notes</userMemory>',
		});
	});

	it('is undefined for a host that keeps its context in the system prompt', () => {
		expect(chatContextBlock([system('<environment_context>Go.</environment_context>'), user('<userRequest>go</userRequest>')])).toBeUndefined();
	});

	it('stops at the first request, so a turn is never taken for the chat context', () => {
		expect(chatContextBlock([user('<userRequest>one</userRequest>'), user('<workspace_info>tree</workspace_info>')])).toBeUndefined();
	});
});

describe('customInstructionsBlock', () => {
	const intro = 'When generating code, please follow these user provided coding instructions. You can ignore an instruction if it contradicts a system message.';
	const instructions = `${intro}\n<instructions>\nUse tabs.\n</instructions>`;
	const mode = '<modeInstructions>\nYou are currently running in "Plan" mode.\n</modeInstructions>';

	it('forwards the instructions of the user with their introduction, and the instructions of the mode', () => {
		const block = customInstructionsBlock([
			system('You are Copilot.'),
			user(`${instructions}\n${mode}`),
			user('<userRequest>go</userRequest>'),
		]);

		expect(block).toEqual({ type: 'text', text: `${instructions}\n\n${mode}` });
	});

	it('finds them in the message that carries the request, and keeps them out of the turn text', () => {
		const message = user(`${instructions}\n${mode}\n<context>now</context><userRequest>go</userRequest>`);

		expect(customInstructionsBlock([message])?.text).toContain('Use tabs.');
		expect(toAcpContentBlocks([message])).toEqual([{ type: 'text', text: '<context>now</context>\n\ngo' }]);
	});

	it('sends each distinct block once however many messages repeat it', () => {
		const block = customInstructionsBlock([user(instructions), assistant('ok'), user(`${instructions}\n<userRequest>go</userRequest>`)]);

		expect(block?.text.match(/Use tabs\./g)).toHaveLength(1);
	});

	it('keeps them out of the chat context and of a message that carries nothing else', () => {
		expect(chatContextBlock([user(`${instructions}\n<environment_info>Linux</environment_info>`), user('<userRequest>go</userRequest>')]))
			.toEqual({ type: 'text', text: '<environment_info>Linux</environment_info>' });
		expect(toAcpContentBlocks([user(`${instructions}\n${mode}`)])).toEqual([]);
	});

	it('ignores instructions inside what the user attached, and system messages', () => {
		expect(customInstructionsBlock([
			system(instructions),
			user('<attachments><attachment><instructions>Quoted.</instructions></attachment></attachments><userRequest>go</userRequest>'),
		])).toBeUndefined();
	});
});

describe('prompt edge cases', () => {
	it('keeps the state of the turn when the request itself is empty, as native sends it', () => {
		expect(toAcpContentBlocks([user('<context>x</context><userRequest>   </userRequest>')]))
			.toEqual([{ type: 'text', text: '<context>x</context>' }]);
	});

	it('forwards an unclosed request wrapper as written, rather than dropping it', () => {
		expect(toAcpContentBlocks([user('<userRequest>half a thought')])).toEqual([{ type: 'text', text: '<userRequest>half a thought' }]);
	});

	it('joins every context message Copilot sends ahead of the request, in order', () => {
		const block = chatContextBlock([
			user('<environment_info>Linux</environment_info>'),
			user('<workspace_info>tree</workspace_info>'),
			user('<context>now</context><userRequest>go</userRequest>'),
		]);

		expect(block).toEqual({ type: 'text', text: '<environment_info>Linux</environment_info>\n\n<workspace_info>tree</workspace_info>' });
	});

	it('takes nothing from a message that comes after the request', () => {
		expect(chatContextBlock([
			user('<userRequest>go</userRequest>'),
			user('<workspace_info>tree</workspace_info>'),
		])).toBeUndefined();
	});
});

describe('fingerprint and diverged', () => {
	it('is stable for equal messages and differs when text, role, images or tools differ', () => {
		expect(fingerprint(user('a'))).toBe(fingerprint(user('a')));
		expect(fingerprint(user('a'))).not.toBe(fingerprint(user('b')));
		expect(fingerprint(user('a'))).not.toBe(fingerprint(assistant('a')));
		expect(fingerprint(user('a', image([1])))).not.toBe(fingerprint(user('a', image([2]))));
		expect(fingerprint(assistant(toolCall('1', 'x')))).not.toBe(fingerprint(assistant(toolCall('2', 'x'))));
		expect(fingerprint(user(toolResult('1')))).not.toBe(fingerprint(user(toolResult('2'))));
	});

	it('does not let the text of a system message change the fingerprint', () => {
		// The host re-renders its system prompt between requests (for example the
		// casing of a drive letter), and that is not a change to the conversation.
		const first = system('Git repository root: C:\\repo');
		const second = system('Git repository root: c:\\repo');

		expect(fingerprint(first)).toBe(fingerprint(second));
		expect(fingerprint(first)).not.toBe(fingerprint(user('Git repository root: C:\\repo')));
	});

	it('keeps a chat undiverged when only its system message was re-rendered', () => {
		const before = [system('root: C:\\repo'), user('hi')].map(fingerprint);
		const after = [system('root: c:\\repo'), user('hi'), assistant('hello'), user('more')].map(fingerprint);

		expect(diverged(before, after)).toBe(false);
	});

	it('hashes an image part once', () => {
		const part = image([9, 9, 9]);
		const first = imageFingerprint(user(part));
		expect(imageFingerprint(user(part))).toBe(first);
	});

	it('detects a rewritten history but not a longer one', () => {
		expect(diverged(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
		expect(diverged(['a', 'b'], ['a', 'x', 'c'])).toBe(true);
		expect(diverged(['a', 'b'], ['a'])).toBe(true);
		expect(diverged([], [])).toBe(false);
	});
});

describe('lastUserMessageIndex', () => {
	it('finds the newest user message', () => {
		expect(lastUserMessageIndex([user('a'), assistant('b'), user('c')])).toBe(2);
	});

	it('skips messages that only carry tool results', () => {
		expect(lastUserMessageIndex([user('ask'), assistant(toolCall('1', 't')), user(toolResult('1'))])).toBe(0);
	});

	it('accepts an image-only message', () => {
		expect(lastUserMessageIndex([user('a'), assistant('b'), user(image([1]))])).toBe(2);
	});

	it('falls back to the last user message, then to 0', () => {
		expect(lastUserMessageIndex([assistant('b'), user(toolResult('1'))])).toBe(1);
		expect(lastUserMessageIndex([assistant('b')])).toBe(0);
		expect(lastUserMessageIndex([])).toBe(0);
	});
});

describe('firstUserWordsIn', () => {
	const chat = [user('1'), assistant('a'), user('2'), assistant('b', toolCall('c', 't')), user(toolResult('c')), user('3')];

	it('finds the first message where the user said something', () => {
		expect(firstUserWordsIn(chat, 1, 5)).toBe(2);
		expect(firstUserWordsIn(chat, 3, 6)).toBe(5);
	});

	it('skips replies and messages that only carry tool results', () => {
		expect(firstUserWordsIn(chat, 3, 5)).toBe(-1);
		expect(firstUserWordsIn(chat, 1, 2)).toBe(-1);
	});

	it('accepts an image-only message and an empty range', () => {
		expect(firstUserWordsIn([assistant('a'), user(image([1]))], 0, 2)).toBe(1);
		expect(firstUserWordsIn(chat, 4, 4)).toBe(-1);
	});
});

describe('messages since the last reply', () => {
	const call = assistant(toolCall('1', 't'));

	it('starts right after the last assistant message', () => {
		expect(firstMessageAfterReply([user('a'), call, user(toolResult('1')), user('b')])).toBe(2);
		expect(firstMessageAfterReply([user('a')])).toBe(0);
		expect(firstMessageAfterReply([user('a'), assistant('b')])).toBe(2);
		expect(firstMessageAfterReply([])).toBe(0);
	});

	it('finds what the user typed next to a tool result', () => {
		const words = userWordsAfterReply([user('a'), call, user(toolResult('1')), user('<current_datetime>now</current_datetime>\n\nAlso do X')]);

		expect(words.map(word => (word as { value: string }).value)).toEqual(['<current_datetime>now</current_datetime>\n\nAlso do X']);
	});

	it('keeps an image the user attached', () => {
		const picture = image([1, 2]);

		expect(userWordsAfterReply([user('a'), call, user(toolResult('1')), user(picture)])).toEqual([picture]);
	});

	it('finds nothing when only tool results came back, or when the agent had the last word', () => {
		expect(userWordsAfterReply([user('a'), call, user(toolResult('1'))])).toEqual([]);
		expect(userWordsAfterReply([user('a'), assistant('b')])).toEqual([]);
	});

	it('notices tool results only after the last reply', () => {
		expect(carriesToolResults([user('a'), call, user(toolResult('1'))])).toBe(true);
		expect(carriesToolResults([user('a'), call, user(toolResult('1')), assistant('done'), user('b')])).toBe(false);
		expect(carriesToolResults([user('a')])).toBe(false);
	});
});

describe('toTranscriptBlock', () => {
	it('is undefined when there is nothing to restore', () => {
		expect(toTranscriptBlock([])).toBeUndefined();
	});

	it('renders speakers, tool calls and omitted content in order', () => {
		const block = toTranscriptBlock([
			user('first question', image([1])),
			assistant('thinking', toolCall('1', 'read_file')),
			user(toolResult('1')),
			assistant('the answer'),
		]);

		expect(block?.type).toBe('text');
		const text = block!.text;
		expect(text).toContain('<conversation_so_far>');
		expect(text.indexOf('User: first question')).toBeLessThan(text.indexOf('Assistant: thinking'));
		expect(text).toContain('[1 image(s) omitted]');
		expect(text).toContain('[called tools: read_file]');
		expect(text).toContain('[tool results omitted]');
		expect(text).toContain('Assistant: the answer');
	});

	it('words the framing for a session that missed part of the chat', () => {
		const text = toTranscriptBlock([user('asked elsewhere'), assistant('answered elsewhere')], DEFAULT_TRANSCRIPT_OPTIONS, true)!.text;

		expect(text).toContain('<conversation_since_your_last_turn>');
		expect(text).toContain('went on without you');
		expect(text).not.toContain('<conversation_so_far>');
		expect(text).toContain('User: asked elsewhere\n\nAssistant: answered elsewhere');
	});

	it('drops the leading system prompt and Copilot context wrappers', () => {
		const block = toTranscriptBlock([
			assistant('You are an AI assistant using Copilot SDK'),
			user('<environment_info>big</environment_info><userRequest>real question</userRequest>'),
			assistant('an answer'),
		]);

		expect(block!.text).not.toContain('Copilot SDK');
		expect(block!.text).not.toContain('environment_info');
		expect(block!.text).toContain('User: real question');
	});

	it('keeps the editor context that comes with a request', () => {
		const block = toTranscriptBlock([
			user('<environment_info>big</environment_info><editorContext>The user has src/a.ts open</editorContext><userRequest>explain this</userRequest>'),
			assistant('an answer'),
		]);

		expect(block!.text).toContain('The user has src/a.ts open');
		expect(block!.text).toContain('explain this');
		expect(block!.text).not.toContain('environment_info');
	});

	it('keeps the state of a turn the host sends without a request wrapper', () => {
		const block = toAcpContentBlocks([user('<current_datetime>2026-10-24T12:50:54.417+05:30</current_datetime>\n\nwhat changed?')])[0];
		const text = block?.type === 'text' ? block.text : '';

		expect(text).toContain('2026-10-24T12:50:54.417+05:30');
		expect(text).toContain('what changed?');
	});

	it('drops a system prompt whatever role it arrives with', () => {
		for (const prompt of [system('You are an expert AI programming assistant'), assistant('You are an expert AI programming assistant')]) {
			const block = toTranscriptBlock([
				prompt,
				user('<environment_info>big</environment_info><workspace_info>tree</workspace_info>'),
				user('real question'),
				assistant('an answer'),
			]);

			expect(block!.text).not.toContain('expert AI programming assistant');
			expect(block!.text).not.toContain('environment_info');
			expect(block!.text).not.toContain('workspace_info');
			expect(block!.text).toContain('User: real question');
			expect(block!.text).toContain('Assistant: an answer');
		}
	});

	it('is undefined when no user message was ever sent', () => {
		expect(toTranscriptBlock([system('prompt'), assistant('hello')])).toBeUndefined();
	});

	it('keeps the newest messages when over budget', () => {
		const block = toTranscriptBlock([user('OLDEST ' + 'x'.repeat(200)), assistant('middle ' + 'y'.repeat(200)), user('NEWEST')], { ...DEFAULT_TRANSCRIPT_OPTIONS, maxCharacters: 60 });

		expect(block!.text).toContain('User: NEWEST');
		expect(block!.text).not.toContain('OLDEST');
	});

	it('truncates a single oversized message from the front', () => {
		const block = toTranscriptBlock([user('BEGIN ' + 'z'.repeat(500) + ' END')], { ...DEFAULT_TRANSCRIPT_OPTIONS, maxCharacters: 50 });

		expect(block!.text).toContain('END');
		expect(block!.text).not.toContain('BEGIN');
		expect(block!.text).toContain('…');
	});

	describe('full detail', () => {
		const full = { ...DEFAULT_TRANSCRIPT_OPTIONS, detail: 'full' as const };
		const call = new LanguageModelToolCallPart('1', 'read_file', { path: 'a.ts' });
		const result = (text: string) => new LanguageModelToolResultPart('1', [new LanguageModelTextPart(text)]);

		it('includes tool arguments and results', () => {
			const block = toTranscriptBlock([user('q'), assistant('looking', call), user(result('file body')), assistant('done')], full);

			expect(block!.text).toContain('[tool call read_file: {"path":"a.ts"}]');
			expect(block!.text).toContain('[tool result: file body]');
			expect(block!.text).not.toContain('omitted');
		});

		it('cuts a tool result to the per-result limit', () => {
			const block = toTranscriptBlock([user('q'), assistant('x', call), user(result('A'.repeat(500)))], { ...full, maxToolResultCharacters: 100 });

			expect(block!.text).toContain('A'.repeat(100));
			expect(block!.text).not.toContain('A'.repeat(101));
			expect(block!.text).toContain('400 more character(s) cut');
		});

		it('still keeps the newest messages when over budget', () => {
			const block = toTranscriptBlock([user('OLDEST'), assistant('x', call), user(result('B'.repeat(300))), user('NEWEST')], { ...full, maxCharacters: 40 });

			expect(block!.text).toContain('NEWEST');
			expect(block!.text).not.toContain('OLDEST');
		});
	});
});
