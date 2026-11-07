import { describe, expect, it } from 'vitest';
import { logCache, logContextCall, logTokens } from '../../src/core/provider/usageReport';
import type { ActiveTurn } from '../../src/core/provider/types';

const usage = { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 9000, cachedWriteTokens: 0, totalTokens: 10050 };

describe('logContextCall', () => {
	it('numbers the calls of a turn and adds up what they sent', () => {
		const turn = { contextCalls: 0, contextSent: 0 } as ActiveTurn;
		const lines: string[] = [];
		logContextCall(turn, 46000, 475000, line => lines.push(line));
		logContextCall(turn, 47500, undefined, line => lines.push(line));
		expect(lines).toEqual([
			'Model call #1: 46000 token(s) in context of 475000; 46000 token(s) sent so far this turn.',
			'Model call #2: 47500 token(s) in context; 93500 token(s) sent so far this turn.',
		]);
	});
});

describe('logCache', () => {
	it('says how many model calls a turn figure adds up', () => {
		const lines: string[] = [];
		logCache('Turn cache', usage, line => lines.push(line), 55);
		logCache('Turn cache', usage, line => lines.push(line));
		logCache('Model call', usage, line => lines.push(line), 3);
		expect(lines).toEqual([
			'Turn cache: 90.0% hit (9000 cached, 1000 fresh, 0 written, summed over 55 model call(s)).',
			'Turn cache: 90.0% hit (9000 cached, 1000 fresh, 0 written).',
			'Model call: 90.0% hit (9000 cached, 1000 fresh, 0 written).',
		]);
	});
});

describe('logTokens', () => {
	it('lists the tokens without a cache hit rate', () => {
		const lines: string[] = [];
		logTokens({ inputTokens: 120, outputTokens: 30, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 195, reasoningOutputTokens: 45 }, line => lines.push(line));
		logTokens({ inputTokens: 5, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 7 }, line => lines.push(line));
		expect(lines).toEqual(['Turn tokens: 120 in, 30 out, 45 of thinking.', 'Turn tokens: 5 in, 2 out.']);
	});
});
