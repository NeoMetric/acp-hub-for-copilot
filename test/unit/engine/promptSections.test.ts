/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { chatPartOf, mergePromptChange, openingPromptOf, promptChangeOf, promptsDiffer, savedSectionsOf, sectionsHashOf } from '../../../src/engine/chat/promptSections';
import type { PromptSection } from '../../../src/engine/model/chat';

describe('prompt sections', () => {
	it('joins the sections of the prompt in order and leaves chat sections out', () => {
		const sections: PromptSection[] = [{ id: 'a', text: 'A' }, { id: 'c', kind: 'chat', text: 'C' }, { id: 'f', kind: 'fixed', text: 'F' }];

		expect(openingPromptOf(sections)).toBe('A\n\nF');
		expect(chatPartOf(sections)).toBe('C');
		expect(openingPromptOf(undefined)).toBeUndefined();
		expect(chatPartOf([{ id: 'a', text: 'A' }])).toBeUndefined();
	});

	it('gives two chats the same opening prompt when only their chat sections differ', () => {
		const one: PromptSection[] = [{ id: 'a', text: 'A' }, { id: 'c', kind: 'chat', text: 'one' }];
		const two: PromptSection[] = [{ id: 'a', text: 'A' }, { id: 'c', kind: 'chat', text: 'two' }];

		expect(openingPromptOf(one)).toBe(openingPromptOf(two));
		expect(sectionsHashOf(one)).toBe(sectionsHashOf(two));
	});

	it('hashes only unmarked sections, folding case and spacing', () => {
		const base: PromptSection[] = [{ id: 'a', text: 'Use Tabs' }, { id: 'c', kind: 'chat', text: 'one' }, { id: 'f', kind: 'fixed', text: 'F' }];
		const hash = sectionsHashOf(base);

		expect(sectionsHashOf([{ id: 'a', text: ' use  tabs ' }, { id: 'c', kind: 'chat', text: 'two' }, { id: 'f', kind: 'fixed', text: 'G' }])).toBe(hash);
		expect(sectionsHashOf([{ id: 'a', text: 'Use spaces' }, base[1], base[2]])).not.toBe(hash);
	});

	it('tells a changed chat section but not a changed fixed section', () => {
		const before: PromptSection[] = [{ id: 'a', text: 'A' }, { id: 'c', kind: 'chat', text: 'one' }, { id: 'f', kind: 'fixed', text: 'F' }];

		expect(promptsDiffer(before, [before[0], { id: 'c', kind: 'chat', text: 'two' }, before[2]])).toBe(true);
		expect(promptsDiffer(before, [before[0], before[1], { id: 'f', kind: 'fixed', text: 'G' }])).toBe(false);
	});

	const rules: PromptSection = { id: 'guidance', text: 'Rules' };
	const agent: PromptSection = { id: 'mode:Agent', label: 'Agent mode', text: 'You are currently running in "Agent" mode.\nDo work' };
	const ask: PromptSection = { id: 'mode:Ask', label: 'Ask mode', text: 'Ask line' };

	it('retires a labelled section that is gone and sends the new one whole', () => {
		const change = promptChangeOf(savedSectionsOf([rules, agent]), [rules, ask], [rules, agent]);

		expect(change.retired).toEqual([{ id: 'mode:Agent', label: 'Agent mode' }]);
		expect(change.added).toEqual(['Ask line']);
		expect(change.addedSections).toEqual(['mode:Ask']);
		expect(change.goneLines).toEqual([]);
	});

	it('lists the lines of an unlabelled section that is gone', () => {
		const other: PromptSection = { id: 'other', text: 'One\nTwo' };
		const change = promptChangeOf(savedSectionsOf([rules, other]), [rules], [rules, other]);

		expect(change.goneLines).toEqual(['One', 'Two']);
		expect(change.retired ?? []).toEqual([]);
	});

	it('treats a session saved without sections as knowing nothing', () => {
		const change = promptChangeOf(undefined, [rules, ask]);

		expect(change.added).toEqual(['Rules', 'Ask line']);
		expect(change.removed).toBe(0);
	});

	it('cancels a retirement when the section returns before the change is sent', () => {
		const away = promptChangeOf(savedSectionsOf([rules, agent]), [rules, ask], [rules, agent]);
		const back = promptChangeOf(savedSectionsOf([rules, ask]), [rules, agent], [rules, ask]);
		const merged = mergePromptChange(away, back);

		expect(merged.retired ?? []).toEqual([]);
		expect(merged.added).toContain('Do work');
	});
});
