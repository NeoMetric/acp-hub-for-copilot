import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, UsageContext, UsageReading } from '../../src/core/adapter';
import { FRESH_MS, UsageStore } from '../../src/core/usage';

const ctx = {} as UsageContext;
const reading: UsageReading = { windows: [{ label: '5-hour', usedPercent: 40 }] };

function adapterWith(read: () => Promise<UsageReading | undefined>): AgentAdapter {
	return { id: 'demo', usage: { read } } as unknown as AgentAdapter;
}

describe('UsageStore', () => {
	it('reports unsupported for an agent without a usage source', async () => {
		const store = new UsageStore(() => { });
		await store.refresh({ id: 'plain' } as unknown as AgentAdapter, ctx);
		expect(store.get('plain').status).toBe('unsupported');
	});

	it('keeps a token-weighted cache rate separately for each agent', () => {
		const store = new UsageStore(() => { });
		store.recordTurn('one', { inputTokens: 25, outputTokens: 0, cachedReadTokens: 75, cachedWriteTokens: 0, totalTokens: 100 }, false);
		store.recordTurn('one', { inputTokens: 75, outputTokens: 0, cachedReadTokens: 25, cachedWriteTokens: 0, totalTokens: 100 }, false);
		expect(store.get('one').extraWindows).toEqual([{ label: 'Cache hit rate', usedPercent: 50 }]);
		expect(store.get('two').extraWindows).toEqual([]);
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
