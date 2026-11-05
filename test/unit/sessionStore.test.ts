/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { guidanceChangeOf, guidanceLineHashes } from '../../src/core/provider';
import { guidanceChangeBlock } from '../../src/core/provider/assemble';
import { mergeGuidanceChange } from '../../src/core/provider/keys';
import { describeToolChange, toolChangeOf } from '../../src/core/provider/keys';
import { findForkSource, hashAll, isPrefixOf, mismatchOf, SavedSessionStore, toolsHashOf, type ReuseCheck, type SavedSession } from '../../src/core/sessionStore';

const check: ReuseCheck = { cwd: '/work', toolsHash: toolsHashOf(['a', 'b']), guidanceHash: 'g1' };

function saved(key: string, history: string[], overrides: Partial<SavedSession> = {}): SavedSession {
	return { key, sessionId: `s-${key}`, cwd: '/work', history: hashAll(history), toolsHash: check.toolsHash, guidanceHash: check.guidanceHash, promptHash: 'p', savedAt: 1, ...overrides };
}

describe('toolsHashOf', () => {
	it('ignores the order of the tools', () => {
		expect(toolsHashOf(['b', 'a'])).toBe(toolsHashOf(['a', 'b']));
		expect(toolsHashOf(['a'])).not.toBe(toolsHashOf(['a', 'b']));
	});
});

describe('isPrefixOf', () => {
	it('accepts the start of a longer list and rejects a change', () => {
		expect(isPrefixOf(hashAll(['u1', 'a1']), hashAll(['u1', 'a1', 'u2']))).toBe(true);
		expect(isPrefixOf(hashAll(['u1', 'x']), hashAll(['u1', 'a1', 'u2']))).toBe(false);
		expect(isPrefixOf(hashAll(['u1', 'a1', 'u2']), hashAll(['u1', 'a1']))).toBe(false);
	});
});

describe('mismatchOf', () => {
	it('names what changed', () => {
		expect(mismatchOf(saved('k', ['u1']), check)).toBeUndefined();
		expect(mismatchOf(saved('k', ['u1'], { cwd: '/other' }), check)).toContain('folder');
		expect(mismatchOf(saved('k', ['u1'], { toolsHash: 'x' }), check)).toContain('tools');
		expect(mismatchOf(saved('k', ['u1'], { guidanceHash: 'x' }), check)).toContain('guidance');
	});

	it('can leave the guidance out while still checking the rest', () => {
		expect(mismatchOf(saved('k', ['u1'], { guidanceHash: 'x' }), check, { ignoreGuidance: true })).toBeUndefined();
		expect(mismatchOf(saved('k', ['u1'], { guidanceHash: 'x', toolsHash: 'y' }), check, { ignoreGuidance: true })).toContain('tools');
	});

	it('can leave the tools out while still checking the rest', () => {
		const options = { ignoreGuidance: true, ignoreTools: true };
		expect(mismatchOf(saved('k', ['u1'], { guidanceHash: 'x', toolsHash: 'y' }), check, options)).toBeUndefined();
		expect(mismatchOf(saved('k', ['u1'], { toolsHash: 'y', cwd: '/other' }), check, options)).toContain('folder');
	});
});

describe('toolChangeOf', () => {
	it('lists the tools added and removed', () => {
		expect(toolChangeOf(['a', 'b'], ['b', 'c', 'd'])).toEqual({ added: ['c', 'd'], removed: ['a'] });
		expect(toolChangeOf(['a'], ['a'])).toEqual({ added: [], removed: [] });
		expect(describeToolChange({ added: ['c'], removed: [] })).toBe('1 tool(s) added (c), 0 removed');
	});
});

describe('guidanceChangeOf', () => {
	const before = guidanceLineHashes('Rules\n\nUse tabs\nSkills: a, b');

	it('reports the lines gained and lost', () => {
		expect(guidanceChangeOf(before, 'Rules\nUse tabs\nSkills: a, b, c')).toEqual({ added: ['Skills: a, b, c'], removed: 1 });
		expect(guidanceChangeOf(before, 'rules\n  USE TABS  \nSkills: a, b')).toEqual({ added: [], removed: 0 });
	});

	it('treats everything as new when the saved lines are unknown', () => {
		expect(guidanceChangeOf(undefined, 'a\nb')).toEqual({ added: ['a', 'b'], removed: 0 });
	});

	const rules = 'Rules\nUse tabs';
	const planning = `${rules}\n<modeInstructions>\nYou are currently running in "Plan" mode. Below are your instructions.\nDo not edit files.\nAsk before acting.\n</modeInstructions>`;

	it('names the mode that was left instead of listing its lines', () => {
		const change = guidanceChangeOf(guidanceLineHashes(planning), rules, planning);

		expect(change.leftMode).toBe('Plan');
		expect(change.goneLines).toEqual([]);
		expect(change.removed).toBe(5);
	});

	it('names the old mode and adds the new one when the mode changes', () => {
		const reviewing = `${rules}\n<modeInstructions>\nYou are currently running in "Review" mode. Below are your instructions.\nOnly read.\n</modeInstructions>`;
		const change = guidanceChangeOf(guidanceLineHashes(planning), reviewing, planning);

		expect(change.leftMode).toBe('Plan');
		expect(change.added).toContain('Only read.');
		expect(change.goneLines).toEqual([]);
	});

	it('lists the other lines that are gone and names no mode when none was left', () => {
		const change = guidanceChangeOf(guidanceLineHashes(planning), planning.replace('Use tabs', 'Use spaces'), planning);

		expect(change.leftMode).toBeUndefined();
		expect(change.goneLines).toEqual(['Use tabs']);
	});

	it('merges a change that was not sent yet with the next one', () => {
		const left = guidanceChangeOf(guidanceLineHashes(planning), rules, planning);
		const back = guidanceChangeOf(guidanceLineHashes(rules), planning, rules);
		const merged = mergeGuidanceChange(left, back);

		expect(merged.leftMode).toBeUndefined();
		expect(merged.added).toContain('Do not edit files.');
	});
});

describe('guidanceChangeBlock', () => {
	it('retracts a mode by name and sends the instructions of the new one whole', () => {
		const long = 'x'.repeat(20_000);
		const block = guidanceChangeBlock({ added: ['You are currently running in "Review" mode.', long], removed: 5, leftMode: 'Plan', goneLines: [] });

		expect(block.text).toContain('You are no longer in "Plan" mode; its instructions no longer apply.');
		expect(block.text).toContain(long);
		expect(block.text).not.toContain('line(s) of the earlier guidance');
	});

	it('shows a short preview of the other lines that are gone, and counts the rest', () => {
		const gone = Array.from({ length: 25 }, (_, index) => `rule ${index} ${'y'.repeat(100)}`);
		const text = guidanceChangeBlock({ added: [], removed: 25, goneLines: gone }).text;

		expect(text).toContain('These lines of the earlier guidance no longer apply:');
		expect(text).toContain(`- rule 0 ${'y'.repeat(73)}…`);
		expect(text).toContain('- … and 5 more');
		expect(text).not.toContain('<guidance_update>');
	});

	it('only counts the lines that are gone when the earlier guidance is unknown', () => {
		expect(guidanceChangeBlock({ added: ['a'], removed: 3 }).text).toContain('3 line(s) of the earlier guidance no longer apply.');
	});
});

describe('findForkSource', () => {
	const incoming = hashAll(['sys', 'u1', 'a1', 'u2']);

	it('finds the session whose messages start the forked chat', () => {
		const source = saved('src', ['sys', 'u1']);
		expect(findForkSource([source], incoming, 3, check)).toBe(source);
	});

	it('prefers the longest match', () => {
		const short = saved('short', ['sys']);
		const long = saved('long', ['sys', 'u1']);
		expect(findForkSource([short, long], incoming, 3, check)).toBe(long);
	});

	it('rejects a fork taken before the latest turn of its source', () => {
		const source = saved('src', ['sys', 'u1', 'a1', 'u2', 'a2', 'u3']);
		expect(findForkSource([source], incoming, 3, check)).toBeUndefined();
	});

	it('rejects a source with other messages, other tools, or another folder', () => {
		expect(findForkSource([saved('x', ['sys', 'other'])], incoming, 3, check)).toBeUndefined();
		expect(findForkSource([saved('x', ['sys', 'u1'], { toolsHash: 'y' })], incoming, 3, check)).toBeUndefined();
		expect(findForkSource([saved('x', ['sys', 'u1'], { cwd: '/o' })], incoming, 3, check)).toBeUndefined();
	});
});

describe('SavedSessionStore', () => {
	function memento(): vscode.Memento {
		const values = new Map<string, unknown>();
		return {
			keys: () => [...values.keys()],
			get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
			update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); },
		} as vscode.Memento;
	}

	it('replaces the entry of a key and forgets it', () => {
		const store = new SavedSessionStore(memento(), 'test.savedSessions');
		store.save({ ...saved('k', ['u1']), savedAt: Date.now() });
		store.save({ ...saved('k', ['u1', 'u2']), sessionId: 'next', savedAt: Date.now() });
		expect(store.all()).toHaveLength(1);
		expect(store.find('k')?.sessionId).toBe('next');
		store.forget('k');
		expect(store.find('k')).toBeUndefined();
	});

	it('drops entries that are too old', () => {
		const store = new SavedSessionStore(memento(), 'test.savedSessions');
		store.save({ ...saved('old', ['u1']), savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
		expect(store.all()).toHaveLength(0);
	});

	it('does nothing without extension state', () => {
		const store = new SavedSessionStore(undefined, 'test.savedSessions');
		store.save(saved('k', ['u1']));
		expect(store.all()).toEqual([]);
	});
});
