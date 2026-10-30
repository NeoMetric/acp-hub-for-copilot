/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AcpTokenUsage } from '../../src/core/agentClient';
import { CacheTracker, cacheTooltip, hitRateOf } from '../../src/core/cache';

const turn = (cachedReadTokens: number, inputTokens: number, cachedWriteTokens: number, outputTokens = 10): AcpTokenUsage => ({
	inputTokens,
	outputTokens,
	cachedReadTokens,
	cachedWriteTokens,
	totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
});

/** A long agent turn and a chat-title request, with the counts the extension logged for them. */
const longTurn = turn(207_704, 8, 1_835, 994);
const titleRequest = turn(0, 2, 3_000, 12);

describe('hitRateOf', () => {
	it('is the share of the input served from the cache', () => {
		expect(hitRateOf(turn(75, 5, 20))).toBeCloseTo(75);
		expect(hitRateOf(longTurn)).toBeCloseTo(99.1, 1);
	});

	it('is 0 when there was no input at all', () => {
		expect(hitRateOf(turn(0, 0, 0))).toBe(0);
	});
});

describe('CacheTracker', () => {
	it('has nothing to show before a turn was recorded', () => {
		const tracker = new CacheTracker();

		expect(tracker.latest).toBeUndefined();
		expect(tracker.overall).toBeUndefined();
	});

	it('ignores turns without usage or without input', () => {
		const tracker = new CacheTracker();

		expect(tracker.record(undefined)).toBe(false);
		expect(tracker.record(turn(0, 0, 0, 50))).toBe(false);

		expect(tracker.overall).toBeUndefined();
	});

	it('counts tokens, not turns, so a small request cannot drag the rate down', () => {
		const tracker = new CacheTracker();
		tracker.record(longTurn);
		tracker.record(titleRequest, true);

		const meanOfRates = (hitRateOf(longTurn) + hitRateOf(titleRequest)) / 2;
		expect(meanOfRates).toBeLessThan(55);
		expect(tracker.overall!.hitRate).toBeGreaterThan(97);
		expect(tracker.overall!.hitRate).toBeCloseTo(hitRateOf(turn(207_704, 10, 4_835)), 5);
		expect(tracker.overall!.requests).toBe(2);
	});

	it('keeps the last chat turn when a background request follows', () => {
		const tracker = new CacheTracker();
		tracker.record(longTurn);
		tracker.record(titleRequest, true);

		expect(tracker.latest).toMatchObject({ cachedReadTokens: 207_704, outputTokens: 994, background: false });
	});

	it('falls back to a background request while there is no chat turn', () => {
		const tracker = new CacheTracker();
		tracker.record(titleRequest, true);

		expect(tracker.latest).toMatchObject({ cachedWriteTokens: 3_000, background: true });
	});

	it('moves on to a newer chat turn', () => {
		const tracker = new CacheTracker();
		tracker.record(longTurn);
		tracker.record(turn(100, 1, 1));

		expect(tracker.latest).toMatchObject({ cachedReadTokens: 100 });
	});

	it('forgets everything on reset', () => {
		const tracker = new CacheTracker();
		tracker.record(longTurn);

		tracker.reset();

		expect(tracker.latest).toBeUndefined();
		expect(tracker.overall).toBeUndefined();
	});

	it('shows the model calls of a running turn before the turn ends', () => {
		const tracker = new CacheTracker();
		const first = turn(999, 1, 1_000);
		tracker.recordRequest({ call: first, turn: first, background: false });

		expect(tracker.latestRequest).toMatchObject({ cachedReadTokens: 999 });
		expect(tracker.current).toMatchObject({ cachedReadTokens: 999 });
		expect(tracker.latest!.hitRate).toBeCloseTo(hitRateOf(first), 5);
		expect(tracker.overall).toBeUndefined();

		const second = turn(2_000, 2, 10);
		tracker.recordRequest({ call: second, turn: turn(2_999, 3, 1_010), background: false });

		expect(tracker.latestRequest).toMatchObject({ cachedReadTokens: 2_000 });
		expect(tracker.current!.cachedReadTokens).toBe(2_999);
	});

	it('lets the finished turn replace the sums of its model calls', () => {
		const tracker = new CacheTracker();
		const first = turn(999, 1, 1_000);
		tracker.recordRequest({ call: first, turn: first, background: false });

		tracker.record(turn(1_900, 4, 1_100));

		expect(tracker.current).toBeUndefined();
		expect(tracker.latest).toMatchObject({ cachedReadTokens: 1_900 });
		expect(tracker.latestRequest).toMatchObject({ cachedReadTokens: 999 });
	});

	it('keeps a background request out of the live chat figures', () => {
		const tracker = new CacheTracker();
		const call = turn(500, 1, 1);
		tracker.recordRequest({ call, turn: call, background: true });

		expect(tracker.latestRequest).toMatchObject({ cachedReadTokens: 500, background: true });
		expect(tracker.current).toBeUndefined();
	});
});

describe('cacheTooltip', () => {
	it('is empty before any turn was recorded', () => {
		expect(cacheTooltip(new CacheTracker())).toBe('');
	});

	it('shows the last chat turn, the overall rate and the token counts', () => {
		const tracker = new CacheTracker();
		tracker.record(longTurn);
		tracker.record(titleRequest, true);

		const text = cacheTooltip(tracker);

		expect(text).toContain('**Last chat turn:** 99.1% cache hit rate');
		expect(text).toContain(`**This window:** ${tracker.overall!.hitRate.toFixed(1)}% over 2 turns`);
		expect(text).not.toContain('Cached read');
		expect(text).not.toContain('added up over every model call it made:');
		expect(text).toContain('[$(info)](');
		expect(text).toContain('subagent and compaction calls are not counted');
		expect(text.endsWith('---')).toBe(true);
	});

	it('says request, not chat turn, when only a background request was seen', () => {
		const tracker = new CacheTracker();
		tracker.record(titleRequest, true);

		const text = cacheTooltip(tracker);

		expect(text).toContain('**Last request:**');
		expect(text).toContain('over 1 turn ');
	});

	it('reports each model call of a running turn', () => {
		const tracker = new CacheTracker();
		const first = turn(999, 1, 1_000);
		tracker.recordRequest({ call: first, turn: first, background: false });

		const text = cacheTooltip(tracker);

		expect(text).toContain('**Last model call:** 50.0% cache hit rate ');
		expect(text).not.toContain('This turn so far');
		expect(text).not.toContain('This window');
	});

	it('lists the model call first, then the window', () => {
		const tracker = new CacheTracker();
		tracker.record(longTurn);
		const call = turn(999, 1, 1_000);
		tracker.recordRequest({ call, turn: call, background: false });
		tracker.record(longTurn);

		const text = cacheTooltip(tracker);

		expect(text.indexOf('Last model call')).toBeLessThan(text.indexOf('This window'));
		expect(text).not.toContain('Last chat turn');
	});
});
