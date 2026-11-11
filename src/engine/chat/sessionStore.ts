/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { StateStore } from '../ports/state';
import { messageFingerprintOf, shortHash } from './sessionFingerprint';

export { messageFingerprintOf, shortHash };

const MAX_SAVED_SESSIONS = 40;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** The newest checkpoints of one session that are kept; a chat that long forks from its recent turns. */
const MAX_CHECKPOINTS_PER_SESSION = 50;
/** Across all sessions; the oldest sessions give up their oldest checkpoints first. */
const MAX_CHECKPOINTS = 400;
/** The layout of {@link SavedSession} that is written now; an entry without a version is the first one, with no checkpoints. */
export const SAVED_SESSION_VERSION = 2;

/**
 * The end of a finished turn: a point a chat can be forked from. The agent finds the
 * message by its id, or by what it said when the id is no use any more.
 */
export interface Checkpoint {
	/** How many Copilot messages the session holds there, counting the agent's reply that ended the turn. */
	readonly messages: number;
	/** The agent's id of the last message of the turn. */
	readonly messageId: string;
	/** `sha256:<hex>` of that message's text. */
	readonly fingerprint: string;
	/** Which of the agent's messages with that fingerprint this is, counting from 1. */
	readonly occurrence: number;
	/** Message occurrences through this point, including intermediate agent messages. */
	readonly messageCounts?: Readonly<Record<string, number>>;
}

/**
 * What is remembered of a chat's agent session so that a later request can pick
 * the conversation up again instead of pasting it into a new session: after the
 * window was reloaded, or in a chat forked from this one. The agent keeps the
 * transcript on disk; only the way back to it is stored here.
 */
export interface SavedSession {
	/** Absent in entries written before checkpoints existed. */
	readonly version?: number;
	readonly key: string;
	/** The agent's id of the session, which names its transcript. */
	readonly sessionId: string;
	readonly cwd: string;
	/** Hashes of the Copilot messages the session has been given. */
	readonly history: readonly string[];
	/** The tools, the guidance and the session prompt the session opened with; a cache hit needs all three unchanged. */
	readonly toolsHash: string;
	/** The tool names behind `toolsHash`, so a later window can say which tools were added or removed. */
	readonly toolNames?: readonly string[];
	readonly guidanceHash: string;
	readonly promptHash: string;
	/** Hashes of the lines of the guidance, so a later window can tell what changed when the guidance hash differs. */
	readonly guidanceLines?: readonly string[];
	/** The ends of the turns the session has finished, oldest first. */
	readonly checkpoints?: readonly Checkpoint[];
	/** Set when the extension made this session by forking, so it may remove it from the agent once the entry expires. */
	readonly forked?: boolean;
	readonly savedAt: number;
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

/**
 * Why a saved session cannot serve a request, or undefined when it can.
 * `ignoreGuidance` leaves the guidance out, for a chat resuming its own session:
 * the host renders its prompt differently from one window to the next, and the
 * conversation is worth more than the old wording of that prompt.
 * `ignoreTools` does the same for the tools: Copilot offers a different set from one
 * request to the next, and the resumed session opens with the set of the request.
 */
export function mismatchOf(saved: SavedSession, check: ReuseCheck, options?: { readonly ignoreGuidance?: boolean; readonly ignoreTools?: boolean }): string | undefined {
	if (saved.cwd !== check.cwd) {
		return `folder changed (${saved.cwd} -> ${check.cwd})`;
	}
	if (!options?.ignoreTools && saved.toolsHash !== check.toolsHash) {
		return 'the offered tools changed';
	}
	if (!options?.ignoreGuidance && saved.guidanceHash !== check.guidanceHash) {
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

/** A checkpoint of a saved session that a request continues from. */
export interface CheckpointMatch {
	readonly saved: SavedSession;
	readonly checkpoint: Checkpoint;
}

/**
 * The deepest checkpoint, across `candidates`, whose messages are the start of the request and
 * leave the newest user message for the prompt. A checkpoint inside the saved history is held to
 * the reply message too, and the one at its end only to the messages before the reply, which the
 * history has no hash for. A session counts only when it is in the same folder; the tools and the
 * guidance may differ, since a fork opens with the ones of the request.
 */
export function findCheckpoint(candidates: readonly SavedSession[], incoming: readonly string[], lastUser: number, check: ReuseCheck): CheckpointMatch | undefined {
	let best: CheckpointMatch | undefined;
	for (const saved of candidates) {
		if (mismatchOf(saved, check, { ignoreGuidance: true, ignoreTools: true })) {
			continue;
		}
		for (const checkpoint of saved.checkpoints ?? []) {
			if (checkpoint.messages <= 0 || checkpoint.messages > lastUser || !isPrefixOf(saved.history.slice(0, checkpoint.messages), incoming)) {
				continue;
			}
			const deeper = !best || checkpoint.messages > best.checkpoint.messages || (checkpoint.messages === best.checkpoint.messages && saved.savedAt > best.saved.savedAt);
			if (deeper) {
				best = { saved, checkpoint };
			}
		}
	}
	return best;
}

function isCheckpoint(value: unknown): value is Checkpoint {
	const checkpoint = value as Partial<Checkpoint> | undefined;
	return typeof checkpoint?.messages === 'number' && typeof checkpoint.messageId === 'string' && typeof checkpoint.fingerprint === 'string' && typeof checkpoint.occurrence === 'number';
}

/** An entry in the current layout; an older one has no checkpoints. */
function upgraded(entry: SavedSession): SavedSession {
	if (entry.version === SAVED_SESSION_VERSION) {
		return entry;
	}
	return { ...entry, version: SAVED_SESSION_VERSION, checkpoints: Array.isArray(entry.checkpoints) ? entry.checkpoints.filter(isCheckpoint) : [] };
}

/** Keeps the newest checkpoints of each session and `MAX_CHECKPOINTS` in all, taking from the oldest sessions first. */
function trimCheckpoints(entries: readonly SavedSession[]): SavedSession[] {
	const trimmed = entries.map(entry => (entry.checkpoints?.length ?? 0) > MAX_CHECKPOINTS_PER_SESSION ? { ...entry, checkpoints: entry.checkpoints?.slice(-MAX_CHECKPOINTS_PER_SESSION) } : entry);
	let excess = trimmed.reduce((total, entry) => total + (entry.checkpoints?.length ?? 0), 0) - MAX_CHECKPOINTS;
	if (excess <= 0) {
		return trimmed;
	}
	const byAge = trimmed.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.savedAt - b.entry.savedAt);
	const result = [...trimmed];
	for (const { entry, index } of byAge) {
		if (excess <= 0) {
			break;
		}
		const drop = Math.min(excess, entry.checkpoints?.length ?? 0);
		result[index] = { ...entry, checkpoints: entry.checkpoints?.slice(drop) };
		excess -= drop;
	}
	return result;
}

/** The saved sessions, kept in extension state so they outlive the window. */
export class SavedSessionStore {
	/** storeKey keeps the sessions of different agents apart in the shared extension state. */
	constructor(private readonly state: StateStore | undefined, private readonly storeKey: string) { }

	private get deletionKey(): string {
		return `${this.storeKey}.deletions`;
	}

	/** The entries that have not expired, in the current layout; the first read of an older layout writes it back. */
	all(): SavedSession[] {
		const now = Date.now();
		const stored = this.state?.get<SavedSession[]>(this.storeKey) ?? [];
		const entries = stored.filter(entry => now - entry.savedAt < MAX_AGE_MS).map(upgraded);
		if (stored.some(entry => entry.version !== SAVED_SESSION_VERSION) || entries.length !== stored.length) {
			this.write(entries, stored);
		}
		return entries;
	}

	find(key: string): SavedSession | undefined {
		return this.all().find(entry => entry.key === key);
	}

	save(entry: SavedSession): void {
		const all = this.all();
		const others = all.filter(existing => existing.key !== entry.key);
		this.write(trimCheckpoints([...others, upgraded(entry)].slice(-MAX_SAVED_SESSIONS)), all);
	}

	/** Points the entries of session `from` at `to`, a copy the extension made of it. */
	moveSession(from: string, to: string): void {
		const all = this.all();
		if (all.some(entry => entry.sessionId === from)) {
			this.write(all.map(entry => entry.sessionId === from ? { ...entry, sessionId: to, forked: true } : entry), all);
		}
	}

	forget(key: string): void {
		const all = this.all();
		if (all.some(entry => entry.key === key)) {
			this.write(all.filter(entry => entry.key !== key), all);
		}
	}

	/** Ids of sessions the extension forked whose entry is gone, which the agent may still hold. */
	pendingDeletions(): string[] {
		return this.state?.get<string[]>(this.deletionKey) ?? [];
	}

	settleDeletions(ids: readonly string[]): void {
		const pending = this.pendingDeletions();
		if (pending.some(id => ids.includes(id))) {
			void this.state?.update(this.deletionKey, pending.filter(id => !ids.includes(id)));
		}
	}

	/** Writes the entries; a forked session that no entry names any more is queued for deletion from the agent. */
	private write(entries: readonly SavedSession[], previous: readonly SavedSession[]): void {
		const orphaned = previous.filter(old => old.forked && !entries.some(entry => entry.sessionId === old.sessionId)).map(old => old.sessionId);
		void this.state?.update(this.storeKey, entries);
		if (orphaned.length > 0) {
			void this.state?.update(this.deletionKey, [...new Set([...this.pendingDeletions(), ...orphaned])].slice(-MAX_SAVED_SESSIONS * 2));
		}
	}
}
