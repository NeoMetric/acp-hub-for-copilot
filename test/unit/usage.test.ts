import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, UsageContext, UsageReading } from '../../src/core/adapter';
import { FRESH_MS, READ_TIMEOUT_MS, UsageStore } from '../../src/core/usage';

const ctx = {} as UsageContext;
const reading: UsageReading = { windows: [{ label: '5-hour', usedPercent: 40 }] };

function adapterWith(read: () => Promise<UsageReading | undefined>): AgentAdapter {
	return { id: 'demo', usage: { read } } as unknown as AgentAdapter;
}

describe('UsageStore', () => {
	it('stops loading when the agent never answers', async () => {
		vi.useFakeTimers();
		try {
			const store = new UsageStore(() => { });
			const done = store.refresh(adapterWith(() => new Promise(() => { })), ctx);
			expect(store.get('demo').status).toBe('loading');
			await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
			await done;
			expect(store.get('demo')).toMatchObject({ status: 'error', error: 'The agent did not answer in time.' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports unsupported for an agent without a usage source', async () => {
		const store = new UsageStore(() => { });
		await store.refresh({ id: 'plain' } as unknown as AgentAdapter, ctx);
		expect(store.get('plain').status).toBe('unsupported');
	});

	it('keeps a token-weighted cache rate separately for each agent', () => {
		const store = new UsageStore(() => { });
		store.recordTurn('one', { inputTokens: 25, outputTokens: 0, cachedReadTokens: 75, cachedWriteTokens: 0, totalTokens: 100 }, false);
		store.recordTurn('one', { inputTokens: 75, outputTokens: 0, cachedReadTokens: 25, cachedWriteTokens: 0, totalTokens: 100 }, false);
		expect(store.get('one').extraWindows).toEqual([
			{ label: 'Cumulative cache hit rate', usedPercent: 50 },
			{ label: 'Last chat turn cache hit rate', usedPercent: 25 },
		]);
		store.recordTurn('one', { inputTokens: 0, outputTokens: 0, cachedReadTokens: 100, cachedWriteTokens: 0, totalTokens: 100 }, true);
		expect(store.get('one').extraWindows[0].usedPercent).toBeCloseTo(200 / 3);
		expect(store.get('one').extraWindows[1]).toEqual({ label: 'Last chat turn cache hit rate', usedPercent: 25 });
		expect(store.get('two').extraWindows).toEqual([]);
	});

	it('publishes the latest measured chat model call independently of turn totals', () => {
		const store = new UsageStore(() => { });
		const seen: string[] = [];
		store.onDidChange(id => seen.push(id));
		const call = { inputTokens: 20, outputTokens: 5, cachedReadTokens: 60, cachedWriteTokens: 20, totalTokens: 105 };
		const turn = { ...call, inputTokens: 100, cachedReadTokens: 300 };
		store.recordRequest('one', { call, turn, background: false });
		expect(store.get('one').lastModelCall).toMatchObject({ hitRate: 60, inputTokens: 20, cachedReadTokens: 60, cachedWriteTokens: 20, outputTokens: 5, background: false });
		expect(store.get('one').extraWindows).toEqual([]);
		expect(store.get('two').lastModelCall).toBeUndefined();
		store.recordTurn('one', turn, false);
		expect(store.get('one').lastModelCall?.hitRate).toBe(60);
		expect(store.get('one').extraWindows[0].usedPercent).toBeCloseTo(300 / 420 * 100);
		store.recordRequest('one', { call: { ...call, inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0 }, turn, background: true });
		expect(store.get('one').lastModelCall?.hitRate).toBe(60);
		store.recordRequest('two', { call: { ...call, inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 }, turn, background: false });
		expect(store.get('two').lastModelCall).toBeUndefined();
		expect(seen).toEqual(['one', 'one', 'one']);
	});

	it('stores a good reading', async () => {
		const store = new UsageStore(() => { }, () => 1000);
		await store.refresh(adapterWith(() => Promise.resolve(reading)), ctx);
		expect(store.get('demo')).toMatchObject({ status: 'ok', reading, fetchedAt: 1000 });
	});

	it('does not ask again within a minute unless forced', async () => {
		let now = 0;
		const read = vi.fn(() => Promise.resolve(reading));
		const store = new UsageStore(() => { }, () => now);
		const adapter = adapterWith(read);

		await store.refresh(adapter, ctx);
		now = FRESH_MS - 1;
		await store.refresh(adapter, ctx);
		expect(read).toHaveBeenCalledTimes(1);

		await store.refresh(adapter, ctx, true);
		expect(read).toHaveBeenCalledTimes(2);

		now = 3 * FRESH_MS;
		await store.refresh(adapter, ctx);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it('shares one read between concurrent refreshes', async () => {
		const read = vi.fn(() => Promise.resolve(reading));
		const store = new UsageStore(() => { });
		const adapter = adapterWith(read);
		await Promise.all([store.refresh(adapter, ctx), store.refresh(adapter, ctx)]);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('keeps the last good reading when a refresh fails', async () => {
		const store = new UsageStore(() => { });
		await store.refresh(adapterWith(() => Promise.resolve(reading)), ctx);
		await store.refresh(adapterWith(() => Promise.reject(new Error('offline'))), ctx, true);
		expect(store.get('demo')).toMatchObject({ status: 'error', error: 'offline', reading });
	});

	it('is unavailable when the agent is not set up', async () => {
		const store = new UsageStore(() => { });
		await store.refresh(adapterWith(() => Promise.resolve(undefined)), ctx);
		expect(store.get('demo').status).toBe('unavailable');
	});

	it('tells listeners which agent changed, until they unsubscribe', () => {
		const store = new UsageStore(() => { });
		const seen: string[] = [];
		const stop = store.onDidChange(id => seen.push(id));
		store.setExtraWindows('demo', [{ label: 'Cache', usedPercent: 70 }]);
		stop();
		store.setExtraWindows('demo', []);
		expect(seen).toEqual(['demo']);
	});
});
