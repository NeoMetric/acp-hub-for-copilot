/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AcpTokenUsage } from '../engine/acp/protocol';

/**
 * Token counts of one finished turn. A turn can make several model calls (one
 * per tool round trip), and these are the sums over all of them, so the cached
 * read of a long turn is a multiple of the context size.
 */
export interface CacheStats {
	/** Share of the input served from the cache, in percent. */
	readonly hitRate: number;
	readonly cachedReadTokens: number;
	readonly cachedWriteTokens: number;
	/** Input that was neither read from nor written to the cache. */
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** True for a request Copilot made for its own purposes, such as a chat title. */
	readonly background: boolean;
}

/** A chat as the status bar lists it. */
export interface ChatIdentity {
	/** Stable for the chat, whichever agent session serves it. */
	readonly id: string;
	/** The opening words of the chat, since the chat's own title is Copilot's. */
	readonly label: string;
	/** The folder the chat works in, so a window lists only its own chats. */
	readonly workspace: string;
}

type InputCounts = Pick<AcpTokenUsage, 'inputTokens' | 'cachedReadTokens' | 'cachedWriteTokens'>;

function totalInput(usage: InputCounts): number {
	return usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
}

/** Whether two token counts agree on the input side, which is what the cache figures rest on. */
export function sameInput(a: InputCounts, b: InputCounts): boolean {
	return a.inputTokens === b.inputTokens && a.cachedReadTokens === b.cachedReadTokens && a.cachedWriteTokens === b.cachedWriteTokens;
}

/** Share of the input that came from the cache, in percent; 0 when there was no input. */
export function hitRateOf(usage: InputCounts): number {
	const total = totalInput(usage);
	return total > 0 ? (usage.cachedReadTokens / total) * 100 : 0;
}

function statsOf(usage: AcpTokenUsage, background: boolean): CacheStats {
	return {
		hitRate: hitRateOf(usage),
		cachedReadTokens: usage.cachedReadTokens,
		cachedWriteTokens: usage.cachedWriteTokens,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		background,
	};
}

/** What a chat's previous model call left in the prompt cache. */
interface CallBaseline {
	/** Input tokens the cache held for the chat afterwards: what that call read plus what it wrote. */
	readonly cached: number;
	readonly total: number;
	readonly at: number;
}

/** The cache lives five minutes from its last use. */
const CACHE_TTL_MS = 5 * 60_000;
/** Below this the API does not cache a prompt, so a small prefix proves nothing. */
const MIN_CACHEABLE_TOKENS = 1_024;
/** The share of the expected prefix that must be read for the call to count as served. */
const SERVED_SHARE = 0.5;
/** A call that shrinks below this share of the earlier prompt was compacted or rewound, so the old prefix no longer applies. */
const SHRUNK_SHARE = 0.7;
const MAX_TRACKED_CHATS = 200;

/** Cache misses of chats that were already running, as the sidebar shows them. */
export interface MissStats {
	/** Calls that lost a prefix the cache should have held. */
	readonly unexpected: number;
	/** Calls that lost it after the chat sat idle longer than the cache lives; nothing to fix. */
	readonly expired: number;
	/** Tokens that were billed at full price for lack of the cache. */
	readonly lostTokens: number;
}

/**
 * Whether a model call of a chat that already ran missed the cache. The previous
 * call left a prefix of `cached` tokens, which this call extends, so it should read
 * nearly all of that. A first call has nothing to compare with and is never a miss,
 * and neither is a call that shrank the prompt. The cost is the tokens it paid for
 * that the cache should have served.
 */
export function detectMiss(previous: CallBaseline | undefined, call: InputCounts, now: number): { readonly lostTokens: number; readonly expired: boolean } | undefined {
	if (!previous || previous.cached < MIN_CACHEABLE_TOKENS) {
		return undefined;
	}
	const total = totalInput(call);
	if (total < previous.total * SHRUNK_SHARE) {
		return undefined;
	}
	const servable = Math.min(previous.cached, total);
	if (call.cachedReadTokens >= servable * SERVED_SHARE) {
		return undefined;
	}
	return { lostTokens: servable - call.cachedReadTokens, expired: now - previous.at > CACHE_TTL_MS };
}

/**
 * One finished model call of a turn, with the turn's figures so far. The agent
 * makes a call per tool round trip, so this is what the cache serves.
 */
export interface RequestMeasurement {
	/** The chat the call belongs to. */
	readonly chat?: ChatIdentity;
	/** The model call that just finished. */
	readonly call: AcpTokenUsage;
	/** Every model call of the turn so far, this one included. */
	readonly turn: AcpTokenUsage;
	/** True for a request Copilot made for itself, such as a chat title. */
	readonly background: boolean;
}

/** Token sums over the turns recorded. */
export interface CacheTotals {
	readonly cachedRead: number;
	readonly cachedWrite: number;
	readonly uncached: number;
	readonly requests: number;
}

/**
 * Keeps the cache figures of the turns and model calls seen so far. The overall
 * rate adds up tokens instead of averaging the rates of single turns, so a
 * three-thousand token title request weighs what it cost and not as much as a
 * long turn.
 */
export class CacheTracker {

	private lastChat: CacheStats | undefined;
	private last: CacheStats | undefined;
	private lastChatCall: CacheStats | undefined;
	private lastCall: CacheStats | undefined;
	/** The chat turn in flight, added up over the model calls it has made so far. */
	private live: CacheStats | undefined;
	private cachedRead = 0;
	private cachedWrite = 0;
	private uncached = 0;
	private requests = 0;
	private readonly baselines = new Map<string, CallBaseline>();
	private unexpectedMisses = 0;
	private expiredMisses = 0;
	private lostTokens = 0;

	constructor(private readonly now: () => number = Date.now) { }

	/** Adds a finished turn. Returns whether it counted: a turn without input says nothing about the cache. */
	record(usage: AcpTokenUsage | undefined, background = false): boolean {
		if (!background) {
			// The turn's own figures replace the sums of its model calls.
			this.live = undefined;
		}
		if (!usage || totalInput(usage) === 0) {
			return false;
		}

		const stats = statsOf(usage, background);
		this.last = stats;
		if (!background) {
			this.lastChat = stats;
		}
		this.cachedRead += usage.cachedReadTokens;
		this.cachedWrite += usage.cachedWriteTokens;
		this.uncached += usage.inputTokens;
		this.requests += 1;
		return true;
	}

	/** Adds one finished model call, so the figures move while its turn is still running. */
	recordRequest(measurement: RequestMeasurement): boolean {
		const { call, turn, background } = measurement;
		if (totalInput(call) === 0) {
			return false;
		}

		const stats = statsOf(call, background);
		this.lastCall = stats;
		if (background) {
			return true;
		}
		this.trackMiss(measurement.chat?.id, call);

		this.lastChatCall = stats;
		this.live = totalInput(turn) > 0 ? statsOf(turn, false) : undefined;
		return true;
	}

	/** Compares the call with what the chat's previous call left cached. The baseline is kept per chat, so a chat moved to a new session is still compared. */
	private trackMiss(chatId: string | undefined, call: AcpTokenUsage): void {
		if (!chatId) {
			return;
		}
		const now = this.now();
		const miss = detectMiss(this.baselines.get(chatId), call, now);
		if (miss) {
			this.lostTokens += miss.lostTokens;
			if (miss.expired) {
				this.expiredMisses += 1;
			} else {
				this.unexpectedMisses += 1;
			}
		}
		this.baselines.delete(chatId);
		this.baselines.set(chatId, { cached: call.cachedReadTokens + call.cachedWriteTokens, total: totalInput(call), at: now });
		if (this.baselines.size > MAX_TRACKED_CHATS) {
			this.baselines.delete(this.baselines.keys().next().value as string);
		}
	}

	/** Misses among the calls of chats that were already running; `undefined` until one was seen. */
	get misses(): MissStats | undefined {
		return this.unexpectedMisses + this.expiredMisses > 0
			? { unexpected: this.unexpectedMisses, expired: this.expiredMisses, lostTokens: this.lostTokens }
			: undefined;
	}

	/** The live figures: the turn in flight, otherwise the latest chat turn. */
	get latest(): CacheStats | undefined {
		return this.live ?? this.lastChat ?? this.last;
	}

	/** The latest single model call, which is the unit the cache serves. */
	get latestRequest(): CacheStats | undefined {
		return this.lastChatCall ?? this.lastCall;
	}

	/** What the turn in flight has spent so far; `undefined` when no turn is running. */
	get current(): CacheStats | undefined {
		return this.live;
	}

	/** The latest finished turn. */
	get finished(): CacheStats | undefined {
		return this.lastChat ?? this.last;
	}

	/** The hit rate over every request recorded, weighted by tokens. */
	get overall(): { readonly hitRate: number; readonly requests: number } | undefined {
		if (this.requests === 0) {
			return undefined;
		}
		return {
			hitRate: hitRateOf({ inputTokens: this.uncached, cachedReadTokens: this.cachedRead, cachedWriteTokens: this.cachedWrite }),
			requests: this.requests,
		};
	}

	/** The raw token sums behind {@link overall}, so another host can add them to its own. */
	get totals(): CacheTotals {
		return { cachedRead: this.cachedRead, cachedWrite: this.cachedWrite, uncached: this.uncached, requests: this.requests };
	}

	reset(): void {
		this.lastChat = undefined;
		this.last = undefined;
		this.lastChatCall = undefined;
		this.lastCall = undefined;
		this.live = undefined;
		this.cachedRead = 0;
		this.cachedWrite = 0;
		this.uncached = 0;
		this.requests = 0;
		this.baselines.clear();
		this.unexpectedMisses = 0;
		this.expiredMisses = 0;
		this.lostTokens = 0;
	}
}

/** A small info icon whose link title is shown on hover, so the figure beside it explains itself. */
function info(help: string): string {
	return ` [$(info)](https://github.com/NeoMetric/acp-hub-for-copilot#how-it-works "${help.replace(/"/g, "'")}")`;
}

/** The cache part of the status bar tooltip, as Markdown; empty before any request was recorded. */
export function cacheTooltip(tracker: CacheTracker): string {
	return cacheTooltipOf(tracker.latestRequest, tracker.finished, tracker.overall);
}

/** The same section from figures already gathered, e.g. from several extension hosts. */
export function cacheTooltipOf(
	call: CacheStats | undefined,
	finished: CacheStats | undefined,
	overall: { readonly hitRate: number; readonly requests: number } | undefined,
): string {
	if (!overall && !call && !finished) {
		return '';
	}

	const sections: string[] = [];

	// Finest first: one model call, then the whole window. The turn in between is the figure in the status bar itself,
	// so it is listed only when no single call was measured.
	if (call) {
		sections.push(`**${call.background ? "Last request" : "Last model call"}:** ${call.hitRate.toFixed(1)}% cache hit rate${info("Cache hit rate of the single most recent model call, the unit the cache actually serves.")}`);
	} else if (finished) {
		sections.push(`**${finished.background ? "Last request" : "Last chat turn"}:** ${finished.hitRate.toFixed(1)}% cache hit rate${info("Cache hit rate of the last finished turn, added up over every model call it made.")}`);
	}
	if (overall) {
		sections.push(`**This window:** ${overall.hitRate.toFixed(1)}% over ${overall.requests} turn${overall.requests === 1 ? '' : 's'}${info("Cache hit rate over every turn since this window opened, weighted by tokens. Main agent only: subagent and compaction calls are not counted.")}`);
	}

	sections.push("---");
	return `\n\n${sections.join('\n\n')}`;
}
