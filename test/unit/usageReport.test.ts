import { describe, expect, it } from 'vitest';
import { logCache, logContextCall, logTokens, reportUsage } from '../../src/engine/chat/usageReport';
import type { ActiveTurn } from '../../src/engine/chat/types';
import type { StreamEvent } from '../../src/engine/model/stream';

const usage = { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 9000, cachedWriteTokens: 0, totalTokens: 10050 };

/** The `usage` figures Copilot is sent, which its context indicator is built on. */
function usagePart(turn: Partial<ActiveTurn>): { prompt_tokens: number; completion_tokens: number; prompt_tokens_details: { cached_tokens: number } } {
	const events: StreamEvent[] = [];
	const full = { finished: false, streaming: true, characters: 0, reportedTokens: 0, ...turn, sink: (event: StreamEvent) => events.push(event) } as unknown as ActiveTurn;
	reportUsage(full, () => undefined);
	const last = events.at(-1)!;
	if (last.type !== 'usage') {
		throw new Error(`Expected a usage event, got ${last.type}`);
	}
	return { prompt_tokens: last.promptTokens, completion_tokens: last.outputTokens, prompt_tokens_details: { cached_tokens: last.cachedTokens } };
}

describe('reportUsage', () => {
	it('sends the context of the last model call, not the sum of every call of the turn', () => {
		// A turn of three calls of about 25.7k tokens each: the agent reports 76,780 for the turn.
		const part = usagePart({ result: { stopReason: 'end_turn', usage: { inputTokens: 29850, outputTokens: 79, cachedReadTokens: 46930, cachedWriteTokens: 0, totalTokens: 76859 } }, lastCall: { promptTokens: 25749, cachedTokens: 23558 } });

		expect(part.prompt_tokens).toBe(25749);
		expect(part.prompt_tokens_details.cached_tokens).toBe(23558);
	});

	it('keeps the context the agent reported as it runs over the turn sums', () => {
		const part = usagePart({ result: { stopReason: 'end_turn', usage: usage }, contextUsed: 26000, lastCall: { promptTokens: 25000, cachedTokens: 24000 } });

		expect(part.prompt_tokens).toBe(26000 - 50);
	});

	it('falls back to the turn figure for an agent that reports nothing else', () => {
		const part = usagePart({ result: { stopReason: 'end_turn', usage } });

		expect(part.prompt_tokens).toBe(10000);
	});
});

describe('logContextCall', () => {
	it('numbers the calls of a turn and adds up what they sent', () => {
		const turn = { contextCalls: 0, contextSent: 0 } as ActiveTurn;
		const lines: string[] = [];
		logContextCall(turn, 46000, 475000, (line: string) => lines.push(line));
		logContextCall(turn, 47500, undefined, (line: string) => lines.push(line));
		expect(lines).toEqual([
			'Model call #1: 46000 token(s) in context of 475000; 46000 token(s) sent so far this turn.',
			'Model call #2: 47500 token(s) in context; 93500 token(s) sent so far this turn.',
		]);
	});
});

describe('logCache', () => {
	it('says how many model calls a turn figure adds up', () => {
		const lines: string[] = [];
		logCache('Turn cache', usage, (line: string) => lines.push(line), 55);
		logCache('Turn cache', usage, (line: string) => lines.push(line));
		logCache('Model call', usage, (line: string) => lines.push(line), 3);
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
		logTokens({ inputTokens: 120, outputTokens: 30, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 195, reasoningOutputTokens: 45 }, (line: string) => lines.push(line));
		logTokens({ inputTokens: 5, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 7 }, (line: string) => lines.push(line));
		expect(lines).toEqual(['Turn tokens: 120 in, 30 out, 45 of thinking.', 'Turn tokens: 5 in, 2 out.']);
	});
});
