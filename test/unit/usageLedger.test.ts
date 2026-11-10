/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcpTokenUsage } from '../../src/engine/acp/protocol';
import { MAX_WORKSPACES_PER_DAY, UsageLedger, type UsageRecord } from '../../src/engine/usage/ledger';
import { usageRoot } from '../../src/engine/store/paths';

const roots: string[] = [];
let root: string;

function store(): string {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-usage-'));
	roots.push(root);
	return root;
}

/** A local time on a fixed day, so the day and hour a turn lands in are what the test says. */
function at(month: number, day: number, hour: number, minute = 0): number {
	return new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();
}

function counts(input: number, cacheRead: number, cacheWrite: number, output: number, reasoning?: number): AcpTokenUsage {
	return {
		inputTokens: input,
		cachedReadTokens: cacheRead,
		cachedWriteTokens: cacheWrite,
		outputTokens: output,
		totalTokens: input + cacheRead + cacheWrite + output,
		...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
	};
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		at: at(11, 10, 13, 30),
		agent: 'claude',
		workspace: '/repo/app',
		usage: counts(100, 900, 40, 300),
		...overrides,
	};
}

function ledgerAt(month: number, day: number, hour = 14): UsageLedger {
	return new UsageLedger({ root, retainDays: 30, now: () => at(month, day, hour), flushDelayMs: 60_000 });
}

/** One row of a day file as it sits on disk. */
interface WireRow {
	h: number;
	w: string;
	a: string;
	in: number;
	cr: number;
	cw: number;
	out: number;
}

function fileOf(day: string): string {
	return path.join(usageRoot(root), `${day}.json`);
}

function rowsOf(day: string): WireRow[] {
	return (JSON.parse(fs.readFileSync(fileOf(day), 'utf8')) as { rows: WireRow[] }).rows;
}

function writeDayFile(day: string, rows: WireRow[]): void {
	fs.mkdirSync(usageRoot(root), { recursive: true });
	fs.writeFileSync(fileOf(day), JSON.stringify({ version: 1, day, rows }));
}

afterEach(() => {
	for (const dir of roots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

describe('recording a turn', () => {
	it('counts a turn into the day, workspace and agent it happened in', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record());
		expect(ledger.daily({}, 1)).toEqual([{
			key: '2026-11-10',
			workspace: '/repo/app',
			agent: 'claude',
			totals: { input: 100, cacheRead: 900, cacheWrite: 40, output: 300 },
		}]);
	});

	it('adds reasoning tokens to the output of a turn', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ usage: counts(0, 0, 0, 300, 50) }));
		expect(ledger.daily({}, 1)[0]?.totals.output).toBe(350);
	});

	it('records nothing for a turn that reported no usage', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ usage: undefined }));
		expect(ledger.daily({}, 1)).toEqual([]);
		expect(ledger.workspaces()).toEqual([]);
	});

	it('files a turn with no known folder under the unknown workspace', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ workspace: undefined }));
		expect(ledger.workspaces()).toEqual(['unknown']);
	});

	it('keeps only the named agent, the named workspace, or both', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ agent: 'claude', workspace: '/a', usage: counts(1, 0, 0, 0) }));
		ledger.record(record({ agent: 'claude', workspace: '/b', usage: counts(2, 0, 0, 0) }));
		ledger.record(record({ agent: 'codex', workspace: '/a', usage: counts(4, 0, 0, 0) }));
		ledger.record(record({ agent: 'codex', workspace: '/b', usage: counts(8, 0, 0, 0) }));

		expect(ledger.daily({ agents: ['claude'] }, 1)).toHaveLength(2);
		expect(ledger.daily({ workspaces: ['/a'] }, 1)).toHaveLength(2);
		expect(ledger.daily({ agents: ['claude'], workspaces: ['/a'] }, 1)).toEqual([{
			key: '2026-11-10',
			workspace: '/a',
			agent: 'claude',
			totals: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
		}]);
	});

	it('files a turn that crosses midnight under the day it was recorded', () => {
		store();
		const ledger = ledgerAt(11, 11);
		ledger.record(record({ at: at(11, 10, 23, 59), usage: counts(1, 0, 0, 0) }));
		ledger.record(record({ at: at(11, 11, 0, 1), usage: counts(2, 0, 0, 0) }));
		expect(ledger.daily({}, 2).map(bucket => [bucket.key, bucket.totals.input])).toEqual([
			['2026-11-10', 1],
			['2026-11-11', 2],
		]);
	});

	it('keeps the turns of one day inside the requested window', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ at: at(11, 9, 10) }));
		ledger.record(record({ at: at(11, 10, 10) }));
		expect(ledger.daily({}, 1).map(bucket => bucket.key)).toEqual(['2026-11-10']);
		expect(ledger.agents()).toEqual(['claude']);
	});
});

describe('flushing a day', () => {
	it('flushes a day to its own file', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record());
		await ledger.flush();
		expect(rowsOf('2026-11-10')).toEqual([{ h: 13, w: '/repo/app', a: 'claude', in: 100, cr: 900, cw: 40, out: 300 }]);
	});

	it('merges into a day file another server already wrote', async () => {
		store();
		writeDayFile('2026-11-10', [{ h: 13, w: '/other/repo', a: 'codex', in: 5, cr: 0, cw: 0, out: 7 }]);
		const ledger = ledgerAt(11, 10);
		ledger.record(record());
		await ledger.flush();
		expect(rowsOf('2026-11-10')).toContainEqual({ h: 13, w: '/other/repo', a: 'codex', in: 5, cr: 0, cw: 0, out: 7 });
		expect(rowsOf('2026-11-10')).toContainEqual({ h: 13, w: '/repo/app', a: 'claude', in: 100, cr: 900, cw: 40, out: 300 });
	});

	it('writes only the days that changed', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ at: at(11, 9, 10) }));
		await ledger.flush();
		const first = fs.statSync(fileOf('2026-11-09')).mtimeMs;
		await new Promise(resolve => setTimeout(resolve, 20));
		ledger.record(record());
		await ledger.flush();
		expect(fs.statSync(fileOf('2026-11-09')).mtimeMs).toBe(first);
		expect(rowsOf('2026-11-10')).toHaveLength(1);
	});

	it('tells its listeners once the flush landed', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		const flushed: number[] = [];
		ledger.onDidFlush(() => flushed.push(1));
		ledger.record(record());
		expect(flushed).toEqual([]);
		await ledger.flush();
		expect(flushed).toEqual([1]);
	});

	it('writes what is pending when it closes', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record());
		await ledger.close();
		expect(rowsOf('2026-11-10')).toHaveLength(1);
	});

	it('keeps the deltas when the write fails, and writes them next time', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record());
		// A folder where the day file should go makes the write fail.
		fs.mkdirSync(fileOf('2026-11-10'), { recursive: true });
		await ledger.flush();
		expect(ledger.daily({}, 1)).toHaveLength(1);
		fs.rmdirSync(fileOf('2026-11-10'));
		await ledger.flush();
		expect(rowsOf('2026-11-10')).toHaveLength(1);
	});
});

describe('reading the store at startup', () => {
	const one = (hour = 13): WireRow[] => [{ h: hour, w: '/repo/app', a: 'claude', in: 100, cr: 900, cw: 40, out: 300 }];

	it('keeps the totals readable after a reload', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record());
		await ledger.flush();
		expect(ledgerAt(11, 10).daily({}, 1)).toEqual([{
			key: '2026-11-10',
			workspace: '/repo/app',
			agent: 'claude',
			totals: { input: 100, cacheRead: 900, cacheWrite: 40, output: 300 },
		}]);
	});

	it('reads the days inside the window at startup and ignores the ones outside it', () => {
		store();
		writeDayFile('2026-11-10', one());
		writeDayFile('2026-01-01', one());
		expect(ledgerAt(11, 10).daily({}, 365).map(bucket => bucket.key)).toEqual(['2026-11-10']);
	});

	it('starts with the other days when one file is corrupt', () => {
		store();
		fs.mkdirSync(usageRoot(root), { recursive: true });
		fs.writeFileSync(fileOf('2026-11-10'), '{"version":1,"day":"2026-11-10","rows":[{');
		writeDayFile('2026-11-09', one());
		expect(ledgerAt(11, 10).daily({}, 30).map(bucket => bucket.key)).toEqual(['2026-11-09']);
	});

	it('skips a day file whose rows are not the expected shape', () => {
		store();
		fs.mkdirSync(usageRoot(root), { recursive: true });
		fs.writeFileSync(fileOf('2026-11-10'), JSON.stringify({ version: 1, day: '2026-11-10', rows: [{ h: 'x' }] }));
		expect(ledgerAt(11, 10).daily({}, 30)).toEqual([]);
	});

	it('reads no folder at all rather than failing when the store has none', () => {
		store();
		expect(ledgerAt(11, 10).daily({}, 30)).toEqual([]);
	});
});

describe('retention', () => {
	it('deletes the files and the memory outside the window', async () => {
		store();
		writeDayFile('2026-10-01', [{ h: 9, w: '/repo', a: 'claude', in: 1, cr: 0, cw: 0, out: 1 }]);
		writeDayFile('2026-11-10', [{ h: 9, w: '/repo', a: 'claude', in: 2, cr: 0, cw: 0, out: 2 }]);
		const ledger = new UsageLedger({ root, retainDays: 365, now: () => at(11, 10, 14), flushDelayMs: 60_000 });
		expect(ledger.daily({}, 365)).toHaveLength(2);

		await ledger.prune(30);
		expect(fs.existsSync(fileOf('2026-10-01'))).toBe(false);
		expect(ledger.daily({}, 365).map(bucket => bucket.key)).toEqual(['2026-11-10']);
		expect(ledger.retainDays()).toBe(30);
	});

	it('clamps the window to what the setting allows', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		await ledger.prune(0);
		expect(ledger.retainDays()).toBe(1);
		await ledger.prune(999);
		expect(ledger.retainDays()).toBe(365);
	});

	it('keeps a day the window still covers', async () => {
		store();
		writeDayFile('2026-11-04', [{ h: 9, w: '/repo', a: 'claude', in: 2, cr: 0, cw: 0, out: 2 }]);
		const ledger = ledgerAt(11, 10);
		await ledger.prune(7);
		expect(fs.existsSync(fileOf('2026-11-04'))).toBe(true);
		expect(ledger.daily({}, 7).map(bucket => bucket.key)).toEqual(['2026-11-04']);
	});
});

describe('the week, hour and workspace views', () => {
	it('sums a week into one bucket keyed by its Monday', () => {
		store();
		const ledger = ledgerAt(11, 12);
		ledger.record(record({ at: at(11, 10, 9), usage: counts(1, 0, 0, 0) }));
		ledger.record(record({ at: at(11, 12, 9), usage: counts(2, 0, 0, 0) }));
		expect(ledger.weekly({}, 30)).toEqual([{
			key: '2026-11-09',
			workspace: '/repo/app',
			agent: 'claude',
			totals: { input: 3, cacheRead: 0, cacheWrite: 0, output: 0 },
		}]);
	});

	it('splits today into the hours that were used', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ at: at(11, 10, 9, 15) }));
		ledger.record(record({ at: at(11, 10, 13, 30) }));
		expect(ledger.hourlyToday({}).map(bucket => bucket.key)).toEqual(['09', '13']);
	});

	it('leaves yesterday out of the hour view', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ at: at(11, 9, 9), usage: counts(1, 0, 0, 0) }));
		expect(ledger.hourlyToday({})).toEqual([]);
	});

	it('honours the filter in the week and hour views too', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ agent: 'claude', workspace: '/a' }));
		ledger.record(record({ agent: 'codex', workspace: '/b' }));
		expect(ledger.weekly({ workspaces: ['/b'] }, 30).every(bucket => bucket.workspace === '/b')).toBe(true);
		expect(ledger.hourlyToday({ agents: ['codex'] }).every(bucket => bucket.agent === 'codex')).toBe(true);
	});

	it('orders the workspaces by the tokens they spent, and takes as many as asked', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ workspace: '/light', usage: counts(1, 0, 0, 0) }));
		ledger.record(record({ workspace: '/heavy', usage: counts(100, 0, 0, 0) }));
		expect(ledger.workspaces()).toEqual(['/heavy', '/light']);
		expect(ledger.workspaces(1)).toEqual(['/heavy']);
	});
});

describe('the workspace cap of a day', () => {
	it('folds the least used workspace into one other row once the day is full', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		const inputs: number[] = [];
		for (let n = 0; n <= MAX_WORKSPACES_PER_DAY; n += 1) {
			const input = 10 * (n + 1);
			inputs.push(input);
			ledger.record(record({ workspace: `/repo/${n}`, usage: counts(input, 0, 0, 0) }));
		}
		await ledger.flush();

		const rows = rowsOf('2026-11-10');
		const workspaces = new Set(rows.map(row => row.w));
		expect(workspaces.size).toBe(MAX_WORKSPACES_PER_DAY);
		expect(workspaces.has('other')).toBe(true);
		expect(workspaces.has('/repo/0')).toBe(false);
		expect(rows.reduce((sum, row) => sum + row.in, 0)).toBe(inputs.reduce((sum, input) => sum + input, 0));
	});

	it('keeps the folded day after a reload', async () => {
		store();
		const ledger = ledgerAt(11, 10);
		for (let n = 0; n <= MAX_WORKSPACES_PER_DAY; n += 1) {
			ledger.record(record({ workspace: `/repo/${n}`, usage: counts(10 * (n + 1), 0, 0, 0) }));
		}
		await ledger.flush();
		const reloaded = ledgerAt(11, 10);
		expect(reloaded.workspaces()).toHaveLength(MAX_WORKSPACES_PER_DAY);
		expect(reloaded.daily({}, 1).reduce((sum, bucket) => sum + bucket.totals.input, 0)).toBe(1530);
	});
});
