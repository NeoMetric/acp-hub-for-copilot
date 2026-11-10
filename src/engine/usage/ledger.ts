/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AcpTokenUsage } from '../acp/protocol';
import type { Log } from '../ports/host';
import { addTotals, isZero, localDayKey, localHour, UNKNOWN_WORKSPACE, type TokenTotals } from './totals';

/** One finished turn, as the chat service reports it. */
export interface UsageRecord {
	readonly at: number;
	/** The id of the agent that answered. */
	readonly agent: string;
	/** The folder the chat worked in, when the host knew it. */
	readonly workspace: string | undefined;
	readonly usage: AcpTokenUsage | undefined;
	/** True for a request the host made for its own purposes, such as a chat title. */
	readonly background: boolean;
}

/** The agents and workspaces a query keeps; an absent list keeps every one. */
export interface UsageQuery {
	readonly agents?: readonly string[];
	readonly workspaces?: readonly string[];
}

/** The totals of one point of a chart: a day, a week, or an hour. */
export interface UsageBucket {
	/** `YYYY-MM-DD` for a day or the Monday of a week, `HH` for an hour. */
	readonly key: string;
	readonly workspace: string;
	readonly agent: string;
	readonly totals: TokenTotals;
}

export interface UsageLedgerOptions {
	/** The store root; the ledgers of one machine live in one folder below it. */
	readonly root: string;
	readonly retainDays: number;
	readonly log?: Log;
	readonly now?: () => number;
	/** How long the ledger waits after the last turn before it writes; a couple of seconds by default. */
	readonly flushDelayMs?: number;
}

export const DEFAULT_RETAIN_DAYS = 30;
export const MAX_RETAIN_DAYS = 365;
/** How many distinct workspaces one day keeps before the lightest is folded into `other`. */
export const MAX_WORKSPACES_PER_DAY = 16;

/** One stored figure of a day: an hour, a workspace and an agent, and what they spent. */
interface UsageRow {
	readonly hour: number;
	readonly workspace: string;
	readonly agent: string;
	totals: TokenTotals;
}

function countsOf(usage: AcpTokenUsage): TokenTotals {
	return {
		input: usage.inputTokens,
		cacheRead: usage.cachedReadTokens,
		cacheWrite: usage.cachedWriteTokens,
		// Reasoning is billed as output, and an agent that reports it adds it on top.
		output: usage.outputTokens + (usage.reasoningOutputTokens ?? 0),
	};
}

function keeps(query: UsageQuery, workspace: string, agent: string): boolean {
	return (query.agents === undefined || query.agents.includes(agent))
		&& (query.workspaces === undefined || query.workspaces.includes(workspace));
}

function orderOf(a: UsageBucket, b: UsageBucket): number {
	return a.key.localeCompare(b.key) || a.workspace.localeCompare(b.workspace) || a.agent.localeCompare(b.agent);
}

/**
 * The token usage of finished turns, kept per day, hour, workspace and agent.
 *
 * A turn only adds to maps in memory; nothing is written and nobody is told.
 * The days reach the disk when the ledger flushes, which is where the cost of
 * keeping this history lives, never on the turn that produced it.
 */
export class UsageLedger {

	private readonly days = new Map<string, Map<string, UsageRow>>();

	constructor(private readonly options: UsageLedgerOptions) { }

	/** Adds one finished turn. In memory only: no write, no await, no listener. */
	record(record: UsageRecord): void {
		if (record.background || !record.usage) {
			return;
		}
		const totals = countsOf(record.usage);
		if (isZero(totals)) {
			return;
		}
		const day = localDayKey(record.at);
		const hour = localHour(record.at);
		const workspace = record.workspace && record.workspace.length > 0 ? record.workspace : UNKNOWN_WORKSPACE;
		this.add(day, { hour, workspace, agent: record.agent, totals });
	}

	/** Every agent that has spent anything inside the days still kept. */
	agents(): string[] {
		return this.distinct(row => row.agent);
	}

	/** Every workspace that has spent anything inside the days still kept. */
	workspaces(): string[] {
		return this.distinct(row => row.workspace);
	}

	/** The whole-day totals of each of the last `days` local days, filtered. */
	daily(query: UsageQuery, days: number): UsageBucket[] {
		const buckets: UsageBucket[] = [];
		for (const key of this.dayKeys(days)) {
			const rows = this.days.get(key);
			if (!rows) {
				continue;
			}
			const sums = new Map<string, UsageBucket>();
			for (const row of rows.values()) {
				if (!keeps(query, row.workspace, row.agent)) {
					continue;
				}
				const at = `${row.workspace}\u0000${row.agent}`;
				const sum = sums.get(at);
				sums.set(at, {
					key,
					workspace: row.workspace,
					agent: row.agent,
					totals: sum ? addTotals(sum.totals, row.totals) : row.totals,
				});
			}
			for (const sum of sums.values()) {
				if (!isZero(sum.totals)) {
					buckets.push(sum);
				}
			}
		}
		return buckets.sort(orderOf);
	}

	/** Adds a row of a day, creating the day and the row as it goes. */
	private add(day: string, row: UsageRow): void {
		let rows = this.days.get(day);
		if (!rows) {
			rows = new Map();
			this.days.set(day, rows);
		}
		const key = `${row.hour}\u0000${row.workspace}\u0000${row.agent}`;
		const existing = rows.get(key);
		rows.set(key, existing ? { ...existing, totals: addTotals(existing.totals, row.totals) } : row);
	}

	private distinct(of: (row: UsageRow) => string): string[] {
		const values = new Set<string>();
		for (const rows of this.days.values()) {
			for (const row of rows.values()) {
				values.add(of(row));
			}
		}
		return [...values].sort((a, b) => a.localeCompare(b));
	}

	/** The day keys of the last `days` local days, ending with today. */
	private dayKeys(days: number): string[] {
		const today = new Date(this.now());
		const keys: string[] = [];
		for (let back = Math.max(1, days) - 1; back >= 0; back -= 1) {
			keys.push(localDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getTime()));
		}
		return keys;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}
