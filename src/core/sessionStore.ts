/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import type * as vscode from 'vscode';

const MAX_SAVED_SESSIONS = 40;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What is remembered of a chat's agent session so that a later request can pick
 * the conversation up again instead of pasting it into a new session: after the
 * window was reloaded, or in a chat forked from this one. The agent keeps the
 * transcript on disk; only the way back to it is stored here.
 */
export interface SavedSession {
	readonly key: string;
	/** The agent's id of the session, which names its transcript. */
	readonly sessionId: string;
	readonly cwd: string;
	/** Hashes of the Copilot messages the session has been given. */
	readonly history: readonly string[];
	/** The tools, the guidance and the session prompt the session opened with; a cache hit needs all three unchanged. */
	readonly toolsHash: string;
	readonly guidanceHash: string;
	readonly promptHash: string;
	readonly savedAt: number;
}

export function shortHash(text: string): string {
	return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function hashAll(values: readonly string[]): string[] {
	return values.map(shortHash);
}

export function toolsHashOf(names: Iterable<string>): string {
	return shortHash([...names].sort().join('\n'));
}

/** Whether the saved messages are exactly the start of the request's messages. */
export function isPrefixOf(saved: readonly string[], incoming: readonly string[]): boolean {
	return saved.length <= incoming.length && saved.every((hash, index) => hash === incoming[index]);
}

export interface ReuseCheck {
	readonly cwd: string;
	readonly toolsHash: string;
	readonly guidanceHash: string;
}

/** Why a saved session cannot serve a request, or undefined when it can. */
export function mismatchOf(saved: SavedSession, check: ReuseCheck): string | undefined {
	if (saved.cwd !== check.cwd) {
		return `folder changed (${saved.cwd} -> ${check.cwd})`;
	}
	if (saved.toolsHash !== check.toolsHash) {
		return 'the offered tools changed';
	}
	if (saved.guidanceHash !== check.guidanceHash) {
		return 'the workspace guidance changed';
	}
	return undefined;
}

/**
 * The saved session a chat with an unknown key was forked from: the one whose
 * messages are exactly the start of this chat's, with the tools and guidance
 * unchanged. A fork taken before the latest turn of its source has fewer
 * messages than the saved session, so it matches nothing; such a fork needs a
 * fork point, which the agent does not get from Copilot.
 */
export function findForkSource(saved: readonly SavedSession[], incoming: readonly string[], lastUser: number, check: ReuseCheck): SavedSession | undefined {
	let best: SavedSession | undefined;
	for (const candidate of saved) {
		if (candidate.history.length === 0 || candidate.history.length > lastUser) {
			continue;
		}
		if (!isPrefixOf(candidate.history, incoming) || mismatchOf(candidate, check)) {
			continue;
		}
		if (!best || candidate.history.length > best.history.length || (candidate.history.length === best.history.length && candidate.savedAt > best.savedAt)) {
			best = candidate;
		}
	}
	return best;
}

/** The saved sessions, kept in extension state so they outlive the window. */
export class SavedSessionStore {
	/** storeKey keeps the sessions of different agents apart in the shared extension state. */
	constructor(private readonly state: vscode.Memento | undefined, private readonly storeKey: string) { }

	all(): SavedSession[] {
		const now = Date.now();
		return (this.state?.get<SavedSession[]>(this.storeKey) ?? []).filter(entry => now - entry.savedAt < MAX_AGE_MS);
	}

	find(key: string): SavedSession | undefined {
		return this.all().find(entry => entry.key === key);
	}

	save(entry: SavedSession): void {
		const others = this.all().filter(existing => existing.key !== entry.key);
		void this.state?.update(this.storeKey, [...others, entry].slice(-MAX_SAVED_SESSIONS));
	}

	forget(key: string): void {
		const all = this.all();
		if (all.some(entry => entry.key === key)) {
			void this.state?.update(this.storeKey, all.filter(entry => entry.key !== key));
		}
	}
}
