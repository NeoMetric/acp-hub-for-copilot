/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { StateStore } from '../../src/engine/ports/state';
import { guidanceChangeOf, guidanceLineHashes } from '../../src/engine/chat/keys';
import { guidanceChangeBlock } from '../../src/engine/chat/assemble';
import { mergeGuidanceChange } from '../../src/engine/chat/keys';
import { describeToolChange, toolChangeOf } from '../../src/engine/chat/keys';
import { findCheckpoint, findForkSource, hashAll, isPrefixOf, messageFingerprintOf, mismatchOf, SavedSessionStore, toolsHashOf, type ReuseCheck, type SavedSession } from '../../src/engine/chat/sessionStore';

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

describe('findCheckpoint', () => {
	const checkpoint = (messages: number, id = `m${messages}`) => ({ messages, messageId: id, fingerprint: messageFingerprintOf(id), occurrence: 1 });
	// The session ran u1 a1 u2 a2 u3, so it holds sys u1 a1 u2 a2 u3 and has a checkpoint after each reply.
	const source = saved('src', ['sys', 'u1', 'a1', 'u2', 'a2', 'u3'], { checkpoints: [checkpoint(3), checkpoint(5), checkpoint(7)] });

	it('picks the deepest checkpoint the request starts with', () => {
		const incoming = hashAll(['sys', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4']);
		expect(findCheckpoint([source], incoming, 7, check)?.checkpoint.messages).toBe(7);
		expect(findCheckpoint([source], hashAll(['sys', 'u1', 'a1', 'u2', 'a2', 'u3x']), 5, check)?.checkpoint.messages).toBe(5);
	});

	it('leaves the newest user message for the prompt', () => {
		const incoming = hashAll(['sys', 'u1', 'a1', 'u2', 'a2', 'u3']);
		expect(findCheckpoint([source], incoming, 5, check)?.checkpoint.messages).toBe(5);
		expect(findCheckpoint([source], hashAll(['sys']), 0, check)).toBeUndefined();
	});

	it('holds a checkpoint inside the history to the reply message as well', () => {
		const edited = hashAll(['sys', 'u1', 'a1-other', 'u2x']);
		expect(findCheckpoint([source], edited, 3, check)).toBeUndefined();
		expect(findCheckpoint([source], hashAll(['sys', 'u1', 'a1', 'u2x']), 3, check)?.checkpoint.messages).toBe(3);
	});

	it('finds nothing for an edit above the first checkpoint, another folder, or a session without checkpoints', () => {
		expect(findCheckpoint([source], hashAll(['sys', 'u1x', 'a1', 'u2']), 3, check)).toBeUndefined();
		expect(findCheckpoint([{ ...source, cwd: '/other' }], hashAll(['sys', 'u1', 'a1', 'u2']), 3, check)).toBeUndefined();
		expect(findCheckpoint([saved('old', ['sys', 'u1'])], hashAll(['sys', 'u1', 'a1', 'u2']), 3, check)).toBeUndefined();
	});

	it('ignores other tools and guidance, which a fork opens with anew', () => {
		const other = { ...source, toolsHash: 'other', guidanceHash: 'other' };
		expect(findCheckpoint([other], hashAll(['sys', 'u1', 'a1', 'u2']), 3, check)?.checkpoint.messages).toBe(3);
	});

	it('prefers the more recent session when two reach the same depth', () => {
		const older = { ...source, sessionId: 'older', savedAt: 1 };
		const newer = { ...source, sessionId: 'newer', savedAt: 2 };
		expect(findCheckpoint([older, newer], hashAll(['sys', 'u1', 'a1', 'u2']), 3, check)?.saved.sessionId).toBe('newer');
	});
});

describe('messageFingerprintOf', () => {
	it('is the lowercase hex sha256 of the UTF-8 text', () => {
		expect(messageFingerprintOf('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(messageFingerprintOf('é')).toBe(`sha256:${createHash('sha256').update(Buffer.from([0xc3, 0xa9])).digest('hex')}`);
	});
});

describe('SavedSessionStore', () => {
	function memento(): StateStore {
		const values = new Map<string, unknown>();
		return {
			keys: () => [...values.keys()],
			get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
			update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); },
		};
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

	it('reads an entry saved before checkpoints existed and upgrades it in place', () => {
		const state = memento();
		void state.update('test.savedSessions', [{ ...saved('k', ['u1']), savedAt: Date.now() }]);
		const store = new SavedSessionStore(state, 'test.savedSessions');

		const [entry] = store.all();

		expect(entry).toMatchObject({ version: 2, key: 'k', sessionId: 's-k', checkpoints: [] });
		expect((state.get<SavedSession[]>('test.savedSessions') ?? [])[0]).toMatchObject({ version: 2, checkpoints: [] });
	});

	it('drops checkpoints that are malformed', () => {
		const state = memento();
		const good = { messages: 3, messageId: 'm', fingerprint: 'sha256:x', occurrence: 1 };
		void state.update('test.savedSessions', [{ ...saved('k', ['u1']), savedAt: Date.now(), checkpoints: [good, { messages: 'x' }, null] }]);

		expect(new SavedSessionStore(state, 'test.savedSessions').all()[0].checkpoints).toEqual([good]);
	});

	it('keeps the newest checkpoints of a session and a bounded number in all', () => {
		const state = memento();
		const store = new SavedSessionStore(state, 'test.savedSessions');
		const checkpoints = (count: number, start = 1) => Array.from({ length: count }, (_, index) => ({ messages: start + index, messageId: `m${start + index}`, fingerprint: 'sha256:x', occurrence: 1 }));

		store.save({ ...saved('long', ['u1']), savedAt: Date.now(), checkpoints: checkpoints(80) });
		expect(store.find('long')?.checkpoints).toHaveLength(50);
		expect(store.find('long')?.checkpoints?.[0].messages).toBe(31);

		for (let index = 0; index < 10; index++) {
			store.save({ ...saved(`chat-${index}`, ['u1']), savedAt: Date.now() + index, checkpoints: checkpoints(50) });
		}
		const total = store.all().reduce((sum, entry) => sum + (entry.checkpoints?.length ?? 0), 0);
		expect(total).toBeLessThanOrEqual(400);
		expect(store.find('chat-9')?.checkpoints).toHaveLength(50);
		expect(store.find('long')?.checkpoints?.length ?? 0).toBeLessThan(50);
	});

	it('queues a forked session for deletion once its entry expires or is replaced, and not before', () => {
		const state = memento();
		const store = new SavedSessionStore(state, 'test.savedSessions');
		store.save({ ...saved('k', ['u1']), sessionId: 'forked', forked: true, savedAt: Date.now() });
		store.save({ ...saved('k', ['u1']), sessionId: 'forked', forked: true, savedAt: Date.now() });
		expect(store.pendingDeletions()).toEqual([]);

		store.save({ ...saved('k', ['u1', 'u2']), sessionId: 'next', savedAt: Date.now() });
		expect(store.pendingDeletions()).toEqual(['forked']);
		store.settleDeletions(['forked']);
		expect(store.pendingDeletions()).toEqual([]);

		store.save({ ...saved('own', ['u1']), sessionId: 'plain', savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
		store.all();
		expect(store.pendingDeletions()).toEqual([]);

		store.save({ ...saved('old', ['u1']), sessionId: 'old-fork', forked: true, savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
		store.all();
		expect(store.pendingDeletions()).toEqual(['old-fork']);
	});

	it('does nothing without extension state', () => {
		const store = new SavedSessionStore(undefined, 'test.savedSessions');
		store.save(saved('k', ['u1']));
		expect(store.all()).toEqual([]);
	});
});
