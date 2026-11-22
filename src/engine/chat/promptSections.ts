/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PromptSection } from '../model/chat';
import { shortHash } from './sessionStore';
import type { GuidanceChange } from './types';

/** A section of the prompt a session was opened with, kept as the hashes of its lines. */
export interface SavedSection {
	readonly id: string;
	readonly label?: string;
	/** The hashes of the distinct lines of the section. */
	readonly lines: readonly string[];
}

/** Case, spacing and path separators folded, so a host's rewording of nothing is no change. */
function fold(text: string | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim().replace(/\\/g, '/').toLowerCase();
}

function join(sections: readonly PromptSection[]): string | undefined {
	return sections.length === 0 ? undefined : sections.map(section => section.text).join('\n\n');
}

/** What the session prompt is made of: every section the host did not mark as belonging to one chat. */
export function openingPromptOf(sections: readonly PromptSection[] | undefined): string | undefined {
	return join((sections ?? []).filter(section => section.kind !== 'chat'));
}

/** What names this chat, sent in the message that opens the session instead of in the cached prompt. */
export function chatPartOf(sections: readonly PromptSection[] | undefined): string | undefined {
	return join((sections ?? []).filter(section => section.kind === 'chat'));
}

/** The sections a change of is a change of the session: not those marked `fixed` or `chat`. */
function unmarked(sections: readonly PromptSection[] | undefined): PromptSection[] {
	return (sections ?? []).filter(section => section.kind === undefined);
}

export function sectionsHashOf(sections: readonly PromptSection[] | undefined): string {
	return shortHash(fold(join(unmarked(sections))));
}

/** Whether the sections that a session keeps after it opens differ; `fixed` ones are written once and never compared. */
export function promptsDiffer(before: readonly PromptSection[] | undefined, after: readonly PromptSection[] | undefined): boolean {
	const key = (sections: readonly PromptSection[] | undefined) => JSON.stringify((sections ?? []).filter(section => section.kind !== 'fixed').map(section => [section.id, fold(section.text)]));
	return key(before) !== key(after);
}

/** The distinct non-empty lines of a text, each with the hash it is compared by. */
function linesOf(text: string): Array<{ text: string; hash: string }> {
	const seen = new Set<string>();
	const lines: Array<{ text: string; hash: string }> = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const hash = shortHash(fold(line));
		if (line && !seen.has(hash)) {
			seen.add(hash);
			lines.push({ text: line, hash });
		}
	}
	return lines;
}

export function savedSectionsOf(sections: readonly PromptSection[] | undefined): SavedSection[] {
	return (sections ?? []).filter(section => section.kind !== 'fixed').map(section => ({
		id: section.id,
		...(section.label === undefined ? {} : { label: section.label }),
		lines: linesOf(section.text).map(line => line.hash),
	}));
}

/**
 * What the sections gained and lost since a session was saved. Lines count across
 * sections, so one that moved from a section to another is not new. A section with a
 * label is retracted by name once it is gone; one without is retracted line by line.
 * A session saved without sections cannot say, so all of the current prompt counts as new.
 */
export function promptChangeOf(saved: readonly SavedSection[] | undefined, after: readonly PromptSection[] | undefined, before?: readonly PromptSection[]): GuidanceChange {
	const current = (after ?? []).filter(section => section.kind !== 'fixed');
	const now = new Map<string, string>();
	for (const section of current) {
		for (const line of linesOf(section.text)) {
			now.set(line.hash, line.text);
		}
	}
	const known = new Set((saved ?? []).flatMap(section => section.lines));
	const added: string[] = [];
	const seen = new Set<string>();
	for (const section of current) {
		for (const line of linesOf(section.text)) {
			if (!known.has(line.hash) && !seen.has(line.hash)) {
				seen.add(line.hash);
				added.push(line.text);
			}
		}
	}
	const change: GuidanceChange = {
		added,
		removed: saved ? [...known].filter(hash => !now.has(hash)).length : 0,
		...(saved ? { addedSections: current.filter(section => !saved.some(old => old.id === section.id)).map(section => section.id) } : {}),
	};
	const retiredSections = (saved ?? []).filter(section => section.label !== undefined && !current.some(next => next.id === section.id));
	const retired = retiredSections.map(section => ({ id: section.id, label: section.label as string }));
	const withRetired = { ...change, ...(retired.length > 0 ? { retired } : {}) };
	if (before === undefined) {
		return withRetired;
	}
	// The lines of a retired section are retracted by its label, so they are not listed again.
	const retiredIds = new Set(retired.map(section => section.id));
	const gone = new Map<string, string>();
	for (const section of before.filter(section => section.kind !== 'fixed' && !retiredIds.has(section.id))) {
		for (const line of linesOf(section.text)) {
			if (!now.has(line.hash)) {
				gone.set(line.hash, line.text);
			}
		}
	}
	return { ...withRetired, goneLines: [...gone.values()] };
}

/** Puts a change that has not been sent yet together with the one that follows it. */
export function mergePromptChange(first: GuidanceChange, second: GuidanceChange): GuidanceChange {
	const added = [...new Set([...first.added, ...second.added])];
	const firstAdded = new Set(first.addedSections);
	const secondAdded = new Set(second.addedSections);
	const retired = [
		...(first.retired ?? []).filter(section => !secondAdded.has(section.id)),
		...(second.retired ?? []).filter(section => !firstAdded.has(section.id)),
	];
	const secondRetired = new Set((second.retired ?? []).map(section => section.id));
	const addedSections = [...(first.addedSections ?? []).filter(id => !secondRetired.has(id)), ...(second.addedSections ?? [])];
	const gone = [...(first.goneLines ?? []), ...(second.goneLines ?? [])].filter(line => !added.includes(line));
	return {
		added,
		removed: first.removed + second.removed,
		...(retired.length > 0 ? { retired } : {}),
		...(addedSections.length > 0 ? { addedSections: [...new Set(addedSections)] } : {}),
		...(first.goneLines || second.goneLines ? { goneLines: [...new Set(gone)] } : {}),
	};
}
