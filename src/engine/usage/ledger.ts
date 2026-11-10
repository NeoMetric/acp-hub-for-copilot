/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AcpTokenUsage } from '../acp/protocol';
import type { Log } from '../ports/host';
import { usageRoot } from '../store/paths';
import { withLock } from '../store/fileStore';
import { addTotals, FOLDED_WORKSPACE, isZero, localDayKey, localHour, UNKNOWN_WORKSPACE, weekStartOf, type TokenTotals } from './totals';

/** One finished turn, as the chat service reports it. */
export interface UsageRecord {
	readonly at: number;
	/** The id of the agent that answered. */
	readonly agent: string;
	/** The folder the chat worked in, when the host knew it. */
	readonly workspace: string | undefined;
	readonly usage: AcpTokenUsage | undefined;
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

/** How long the ledger waits after the last turn before it writes. */
const DEFAULT_FLUSH_DELAY_MS = 2_000;

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

let tempSeq = 0;

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

/** The key of a row, which names the hour, the workspace and the agent it counts. */
function rowKey(row: { readonly hour: number; readonly workspace: string; readonly agent: string }): string {
	return `${row.hour}\u0000${row.workspace}\u0000${row.agent}`;
}

/** Adds a row into a day's rows, creating the day's map and the row as it goes. */
function addTo(rows: Map<string, UsageRow> | undefined, row: UsageRow): Map<string, UsageRow> {
	const next = rows ?? new Map<string, UsageRow>();
	const key = rowKey(row);
	const existing = next.get(key);
	next.set(key, existing ? { ...existing, totals: addTotals(existing.totals, row.totals) } : row);
	return next;
}

/** Where the tallies of one local day live. */
function dayFile(root: string, day: string): string {
	return path.join(usageRoot(root), `${day}.json`);
}

function spentOf(row: UsageRow): number {
	return row.totals.input + row.totals.cacheRead + row.totals.cacheWrite + row.totals.output;
}

/** Adds a row into a set of rows, so a row that is already there grows instead of repeating. */
function mergeInto(rows: Map<string, UsageRow>, row: UsageRow): void {
	const key = rowKey(row);
	const existing = rows.get(key);
	rows.set(key, existing ? { ...existing, totals: addTotals(existing.totals, row.totals) } : row);
}

/**
 * Folds the lightest workspaces of a day into `other` until the day is back under
 * its cap. Done on the rows about to be written, where the file's own rows and the
 * deltas are in view together, so two writers folding at once still agree and no
 * token is counted twice.
 */
function foldDay(rows: Map<string, UsageRow>): void {
	for (;;) {
		const spent = new Map<string, number>();
		let folded = false;
		for (const row of rows.values()) {
			if (row.workspace === FOLDED_WORKSPACE) {
				folded = true;
			} else {
				spent.set(row.workspace, (spent.get(row.workspace) ?? 0) + spentOf(row));
			}
		}
		if (spent.size + (folded ? 1 : 0) <= MAX_WORKSPACES_PER_DAY) {
			return;
		}
		const lightest = [...spent.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]?.[0];
		if (lightest === undefined) {
			return;
		}
		for (const [key, row] of [...rows]) {
			if (row.workspace !== lightest) {
				continue;
			}
			rows.delete(key);
			mergeInto(rows, { hour: row.hour, workspace: FOLDED_WORKSPACE, agent: row.agent, totals: row.totals });
		}
	}
}

/** The rows a day file holds, or `undefined` when it does not parse or holds rows of the wrong shape. */
function parseDay(text: string): UsageRow[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const rows = (parsed as { rows?: unknown } | null)?.rows;
	if (!Array.isArray(rows)) {
		return undefined;
	}
	const kept: UsageRow[] = [];
	for (const row of rows as WireRow[]) {
		if (!row || typeof row !== 'object') {
			return undefined;
		}
		const { h, w, a, in: input, cr, cw, out } = row;
		if (!Number.isInteger(h) || h < 0 || h > 23 || typeof w !== 'string' || typeof a !== 'string' || ![input, cr, cw, out].every(Number.isFinite)) {
			return undefined;
		}
		kept.push({ hour: h, workspace: w, agent: a, totals: { input, cacheRead: cr, cacheWrite: cw, output: out } });
	}
	return kept;
}

/** The rows a day file holds; a day that is not there yet reads as no rows, one that cannot be read throws. */
export async function readDay(file: string): Promise<Map<string, UsageRow>> {
	const rows = new Map<string, UsageRow>();
	let text: string;
	try {
		text = await fs.promises.readFile(file, 'utf8');
} catch (error) {
	// A day that is not there yet is a day with nothing in it; one that cannot be read is
	// left alone, so the caller keeps its rows for the next flush instead of overwriting them.
	if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
		return rows;
	}
	throw error;
}
const parsed = parseDay(text);
if (!parsed) {
	throw new Error(`${file} does not hold usage rows`);
}
for (const row of parsed) {
	rows.set(rowKey(row), row);
}
return rows;
}

/** Writes a day through a temp file in the same folder, so a reader sees the old file or the new one, never half. */
async function writeDay(file: string, day: string, rows: readonly UsageRow[]): Promise<void> {
	const ordered = [...rows].sort((a, b) => a.hour - b.hour || a.workspace.localeCompare(b.workspace) || a.agent.localeCompare(b.agent));
	const document = {
		version: 1,
		day,
		rows: ordered.map(row => ({ h: row.hour, w: row.workspace, a: row.agent, in: row.totals.input, cr: row.totals.cacheRead, cw: row.totals.cacheWrite, out: row.totals.output })),
	};
	const temp = `${file}.${process.pid}.${++tempSeq}.tmp`;
	try {
		await fs.promises.writeFile(temp, `${JSON.stringify(document, undefined, '\t')}\n`, 'utf8');
		await fs.promises.rename(temp, file);
	} catch (error) {
		await fs.promises.rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clampRetain(days: number): number {
	if (!Number.isFinite(days)) {
		return DEFAULT_RETAIN_DAYS;
	}
	return Math.min(MAX_RETAIN_DAYS, Math.max(1, Math.round(days)));
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
	/** What a flush has not written yet, so a second writer's rows are added to instead of overwritten. */
	private readonly deltas = new Map<string, Map<string, UsageRow>>();
	private readonly listeners = new Set<() => void>();
	private timer: NodeJS.Timeout | undefined;
	/** Flushes run one after another, so two of them never write the same day at once. */
	private writing: Promise<void> = Promise.resolve();
	private retain: number;

	constructor(private readonly options: UsageLedgerOptions) {
		this.retain = clampRetain(options.retainDays);
		this.load();
	}

	/** How many days the ledger keeps, as the setting allows. */
	retainDays(): number {
		return this.retain;
	}

	/** Drops the days outside a new window, from memory and from the folder. Lowering it cannot be undone. */
	async prune(retainDays: number): Promise<void> {
		this.retain = clampRetain(retainDays);
		const oldest = this.oldestDay();
		for (const day of [...this.days.keys()]) {
			if (day < oldest) {
				this.days.delete(day);
				this.deltas.delete(day);
			}
		}
		const folder = usageRoot(this.options.root);
		let names: string[];
		try {
			names = await fs.promises.readdir(folder);
		} catch {
			return;
		}
		for (const name of names) {
			const day = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1];
			if (!day || day >= oldest) {
				continue;
			}
			try {
				await fs.promises.rm(path.join(folder, name), { force: true });
			} catch (error) {
				this.options.log?.(`Could not delete the usage day ${name}: ${messageOf(error)}`, 'warn');
			}
		}
	}

	/** Reads the days still inside the window, so a restart continues where the last one stopped. */
	private load(): void {
		const folder = usageRoot(this.options.root);
		let names: string[];
		try {
			names = fs.readdirSync(folder);
		} catch {
			// No folder yet: nothing has ever been flushed.
			return;
		}
		const oldest = this.oldestDay();
		for (const name of names) {
			const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
			const day = match?.[1];
			if (!day || day < oldest) {
				continue;
			}
			const file = path.join(folder, name);
			const rows = this.rowsOfFile(file);
			if (!rows) {
				this.options.log?.(`The usage day ${file} could not be read; it is skipped until the next flush.`, 'warn');
				continue;
			}
			const map = new Map<string, UsageRow>();
			for (const row of rows) {
				map.set(rowKey(row), row);
			}
			this.days.set(day, map);
		}
	}

	/** The rows a day file holds, or `undefined` when it cannot be read at all. */
	private rowsOfFile(file: string): UsageRow[] | undefined {
		try {
			return parseDay(fs.readFileSync(file, 'utf8'));
		} catch {
			return undefined;
		}
	}

	/** The first day still kept, as `YYYY-MM-DD`. */
	private oldestDay(): string {
		const today = new Date(this.now());
		const back = this.retain - 1;
		return localDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getTime());
	}

	/** Adds one finished turn. In memory only: no write, no await, no listener. */
	record(record: UsageRecord): void {
		if (!record.usage) {
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
		this.schedule();
	}

	/** Told once a flush wrote something, which is what redraws the page; never told per turn. */
	onDidFlush(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Writes the days that changed since the last flush, merging into what is already on disk. */
	flush(): Promise<void> {
		this.writing = this.writing.then(() => this.writeDeltas(), () => this.writeDeltas());
		return this.writing;
	}

	/** Stops the pending flush and writes what is still owed before the process goes. */
	async close(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.flush();
	}

	/** Every agent that has spent anything inside the days still kept. */
	agents(): string[] {
		return this.distinct(row => row.agent);
	}

	/** Every workspace that has spent anything inside the days still kept, the heaviest first. */
	workspaces(limit?: number): string[] {
		const spent = new Map<string, number>();
		for (const rows of this.days.values()) {
			for (const row of rows.values()) {
				const total = row.totals.input + row.totals.cacheRead + row.totals.cacheWrite + row.totals.output;
				spent.set(row.workspace, (spent.get(row.workspace) ?? 0) + total);
			}
		}
		const ordered = [...spent.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([workspace]) => workspace);
		return limit === undefined ? ordered : ordered.slice(0, limit);
	}

	/** The totals of each week of the last `days` local days, keyed by the week's Monday. */
	weekly(query: UsageQuery, days: number): UsageBucket[] {
		const weeks = new Map<string, UsageBucket>();
		for (const bucket of this.daily(query, days)) {
			const key = weekStartOf(bucket.key);
			const at = `${key}\u0000${bucket.workspace}\u0000${bucket.agent}`;
			const sum = weeks.get(at);
			weeks.set(at, {
				key,
				workspace: bucket.workspace,
				agent: bucket.agent,
				totals: sum ? addTotals(sum.totals, bucket.totals) : bucket.totals,
			});
		}
		return [...weeks.values()].sort(orderOf);
	}

	/** The totals of each hour of today that anything was spent in. */
	hourlyToday(query: UsageQuery): UsageBucket[] {
		const rows = this.days.get(localDayKey(this.now()));
		if (!rows) {
			return [];
		}
		const buckets: UsageBucket[] = [];
		for (const row of rows.values()) {
			if (!keeps(query, row.workspace, row.agent) || isZero(row.totals)) {
				continue;
			}
			buckets.push({ key: String(row.hour).padStart(2, '0'), workspace: row.workspace, agent: row.agent, totals: row.totals });
		}
		return buckets.sort(orderOf);
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
		this.days.set(day, addTo(this.days.get(day), row));
		this.deltas.set(day, addTo(this.deltas.get(day), row));
	}

	/** Waits for a quiet moment after the last turn before writing, so a burst of turns costs one write. */
	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
		this.timer.unref?.();
	}

	/** Writes every day the deltas name, then drops them; a day whose write failed keeps its deltas for the next flush. */
	private async writeDeltas(): Promise<void> {
		const days = [...this.deltas.keys()];
		let wrote = false;
		for (const day of days) {
			const rows = this.deltas.get(day);
			if (!rows || rows.size === 0) {
				this.deltas.delete(day);
				continue;
			}
			// The rows are taken out of the way before the first await: a turn recorded while this
			// flush is writing lands in a fresh map and is written next time, instead of vanishing
			// with the map that is being dropped here.
			this.deltas.delete(day);
			const file = dayFile(this.options.root, day);
			try {
				await fs.promises.mkdir(path.dirname(file), { recursive: true });
				await withLock(`${file}.lock`, async () => {
					const merged = await readDay(file);
					for (const [key, row] of rows) {
						const current = merged.get(key);
						merged.set(key, current ? { ...current, totals: addTotals(current.totals, row.totals) } : row);
					}
					foldDay(merged);
					await writeDay(file, day, [...merged.values()]);
				});
				wrote = true;
			} catch (error) {
				for (const row of rows.values()) {
					this.deltas.set(day, addTo(this.deltas.get(day), row));
				}
				this.options.log?.(`Could not write the usage day ${day}: ${messageOf(error)}`, 'warn');
			}
		}
		if (!wrote) {
			return;
		}
		for (const listener of [...this.listeners]) {
			listener();
		}
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
