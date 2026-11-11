/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { fingerprint, imageFingerprint, isSystemMessage, textOf } from '../../src/hosts/vscode/messageText';
import { assistant, image, system, toolCall, toolResult, user } from './messages';

describe('textOf', () => {
	it('joins text parts and ignores the rest', () => {
		expect(textOf(user('one', image([1]), 'two'))).toBe('one\ntwo');
	});
});

describe('isSystemMessage', () => {
	it('recognises the role a system prompt arrives with', () => {
		expect(isSystemMessage(system('rules'))).toBe(true);
		expect(isSystemMessage(user('rules'))).toBe(false);
		expect(isSystemMessage(assistant('rules'))).toBe(false);
	});
});

describe('fingerprint', () => {
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

	it('does not let a reminder Copilot adds to a user message change the fingerprint', () => {
		// A tool toggle makes Copilot add a reminder to an earlier user message; the message itself is unchanged.
		const before = user('fix the bug');
		const after = user('<system_reminder>The tools changed.</system_reminder>\nfix the bug');

		expect(fingerprint(after)).toBe(fingerprint(before));
	});

	it('does not count a changed IDE selection or opened file as an edit', () => {
		// A resend carries the selection as it is now; the words of the user are the same.
		const before = user('<ide_selection>The user selected lines 1 to 2 of a.ts</ide_selection>\nfix the bug');
		const after = user('<ide_selection>The user selected lines 9 to 12 of b.ts</ide_selection>\nfix the bug');
		const opened = user('<ide_opened_file>The user opened a.ts</ide_opened_file>fix the bug');

		expect(fingerprint(after)).toBe(fingerprint(before));
		expect(fingerprint(opened)).toBe(fingerprint(user('fix the bug')));
	});

	it('still sees an edit of the words next to an IDE selection', () => {
		const before = user('<ide_selection>lines 1 to 2</ide_selection>\nfix the bug');
		const after = user('<ide_selection>lines 1 to 2</ide_selection>\nfix the other bug');

		expect(fingerprint(after)).not.toBe(fingerprint(before));
	});

	it('hashes an image part once', () => {
		const part = image([9, 9, 9]);
		const first = imageFingerprint(user(part));
		expect(imageFingerprint(user(part))).toBe(first);
	});
});
