/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcpTokenUsage } from '../../src/engine/acp/protocol';
import { UsageLedger, type UsageRecord } from '../../src/engine/usage/ledger';

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
		background: false,
		...overrides,
	};
}

function ledgerAt(month: number, day: number, hour = 14): UsageLedger {
	return new UsageLedger({ root, retainDays: 30, now: () => at(month, day, hour) });
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

	it('records nothing for a background request', () => {
		store();
		const ledger = ledgerAt(11, 10);
		ledger.record(record({ background: true }));
		expect(ledger.daily({}, 1)).toEqual([]);
		expect(ledger.workspaces()).toEqual([]);
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
