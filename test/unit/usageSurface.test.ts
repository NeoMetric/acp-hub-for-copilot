/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcpTokenUsage } from '../../src/engine/acp/protocol';
import { UsageLedger } from '../../src/engine/usage/ledger';
import { createUsageHistorySurface, type UsageSurfaceDeps } from '../../src/hosts/http/usageSurface';

const roots: string[] = [];

function store(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-surface-'));
	roots.push(root);
	return root;
}

function at(month: number, day: number, hour: number, minute = 0): number {
	return new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();
}

function counts(input: number): AcpTokenUsage {
	return { inputTokens: input, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0, totalTokens: input };
}

function surfaceOf(root: string, written: number[] = []): { surface: ReturnType<typeof createUsageHistorySurface>; ledger: UsageLedger } {
	const ledger = new UsageLedger({ root, retainDays: 30, now: () => at(11, 10, 20), flushDelayMs: 60_000 });
	const deps: UsageSurfaceDeps = {
		ledger,
		agents: [{ id: 'claude', displayName: 'Claude Agent' }],
		writeRetention: async days => { written.push(days); },
	};
	return { surface: createUsageHistorySurface(deps), ledger };
}

function turn(ledger: UsageLedger, workspace: string, input: number, agent = 'claude', hour = 10): void {
	ledger.record({ at: at(11, 10, hour), agent, workspace, usage: counts(input), background: false });
}

function sumOf(points: ReadonlyArray<{ v: [number, number, number, number] }>): number {
	return points.reduce((total, point) => total + point.v.reduce((a, b) => a + b, 0), 0);
}

afterEach(() => {
	for (const dir of roots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

describe('the usage history view', () => {
	it('caps the payload at 8 workspaces by folding the rest into other', async () => {
		const { surface, ledger } = surfaceOf(store());
		for (let n = 0; n < 12; n += 1) {
			turn(ledger, `/repo/${n}`, 10 * (n + 1));
		}
		const view = await surface.view();
		expect(view.workspaces).toHaveLength(8);
		expect(view.workspaces.at(-1)?.id).toBe('other');
		expect(sumOf(view.days)).toBe(780);
	});

	it('names an agent the registry no longer has by its id, and keeps its history', async () => {
		const { surface, ledger } = surfaceOf(store());
		turn(ledger, '/repo/app', 5, 'retired-agent');
		const view = await surface.view();
		const index = view.agents.findIndex(agent => agent.id === 'retired-agent');
		expect(index).toBeGreaterThanOrEqual(0);
		expect(view.agents[index]?.name).toBe('retired-agent');
		expect(view.days.some(point => point.a === index)).toBe(true);
	});

	it('names a workspace by its last path segment and keeps the full path as the id', async () => {
		const { surface, ledger } = surfaceOf(store());
		turn(ledger, path.join('C:', 'src', 'app'), 5);
		expect((await surface.view()).workspaces).toEqual([{ id: path.join('C:', 'src', 'app'), name: 'app' }]);
	});

	it('carries a daily, a weekly and an hourly grid', async () => {
		const { surface, ledger } = surfaceOf(store());
		turn(ledger, '/repo/app', 5, 'claude', 9);
		turn(ledger, '/repo/app', 7, 'claude', 13);
		const view = await surface.view();
		expect(view.days.map(point => point.d)).toEqual(['2026-11-10']);
		expect(view.days[0]?.v).toEqual([12, 0, 0, 0]);
		expect(view.weeks.map(point => point.d)).toEqual(['2026-11-09']);
		expect(view.today.map(point => point.d)).toEqual(['09', '13']);
	});

	it('rebuilds only after a flush', async () => {
		const { surface, ledger } = surfaceOf(store());
		turn(ledger, '/repo/app', 5);
		const first = await surface.view();
		expect(await surface.view()).toBe(first);
		await ledger.flush();
		expect(await surface.view()).not.toBe(first);
	});

	it('marks a store that has never recorded anything', async () => {
		const { surface } = surfaceOf(store());
		const view = await surface.view();
		expect(view.empty).toBe(true);
		expect(view.days).toEqual([]);
	});

	it('stores the retention it was given and prunes to it', async () => {
		const written: number[] = [];
		const { surface } = surfaceOf(store(), written);
		await surface.setRetentionDays(7);
		expect(written).toEqual([7]);
		expect((await surface.view()).retentionDays).toBe(7);
	});

	it('clamps a retention the page sends out of range', async () => {
		const written: number[] = [];
		const { surface } = surfaceOf(store(), written);
		await surface.setRetentionDays(0);
		expect(written).toEqual([1]);
	});
});
