/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { UsageBucket, UsageLedger } from '../../engine/usage/ledger';
import { FOLDED_WORKSPACE } from '../../engine/usage/totals';
import type { UsageHistorySurface, UsageHistoryView, UsagePoint } from '../../ui/messages';

/** How many workspaces the payload names, before the rest are folded into `other`. */
const MAX_VIEW_WORKSPACES = 8;
/** How many days the daily grid carries; the weekly grid covers the rest of the retention. */
const MAX_DAILY_DAYS = 30;

export interface UsageSurfaceDeps {
	readonly ledger: UsageLedger;
	/** The agents this host can offer, which names the ones in the history. */
	readonly agents: readonly { readonly id: string; readonly displayName: string }[];
	/** Stores the retention the page asked for, beside the page's other settings. */
	readonly writeRetention: (days: number) => Promise<void>;
}

/**
 * The usage history the page draws, built from the ledger's in-memory days.
 *
 * The view is built once and handed out again until the ledger says a flush
 * landed, so a redraw for any other reason costs nothing.
 */
export function createUsageHistorySurface(deps: UsageSurfaceDeps): UsageHistorySurface {
	const { ledger } = deps;
	let cached: UsageHistoryView | undefined;
	ledger.onDidFlush(() => { cached = undefined; });

	return {
		async view(): Promise<UsageHistoryView> {
			cached ??= build(ledger, deps.agents);
			return cached;
		},

		async setRetentionDays(days: number): Promise<void> {
			// The ledger clamps what the page sends, and the value it kept is the one stored.
			await ledger.prune(days);
			await deps.writeRetention(ledger.retainDays());
			cached = undefined;
		},
	};
}

function build(ledger: UsageLedger, known: UsageSurfaceDeps['agents']): UsageHistoryView {
	const retentionDays = ledger.retainDays();
	const daily = ledger.daily({}, Math.min(MAX_DAILY_DAYS, retentionDays));
	const weekly = ledger.weekly({}, retentionDays);
	const hourly = ledger.hourlyToday({});

	const agents = agentList([...daily, ...weekly, ...hourly], known);
	const workspaces = workspaceList(ledger, [...daily, ...weekly, ...hourly]);

	return {
		retentionDays,
		agents,
		workspaces,
		days: pointsOf(daily, workspaces, agents),
		weeks: pointsOf(weekly, workspaces, agents),
		today: pointsOf(hourly, workspaces, agents),
		empty: daily.length === 0 && weekly.length === 0 && hourly.length === 0,
	};
}

/** The agents of the history, named from the registry when it still knows them, and the ones it no longer does by id. */
function agentList(buckets: readonly UsageBucket[], known: UsageSurfaceDeps['agents']): Array<{ id: string; name: string }> {
	const names = new Map(known.map(agent => [agent.id, agent.displayName]));
	const ids = [...new Set(buckets.map(bucket => bucket.agent))].sort((a, b) => a.localeCompare(b));
	return ids.map(id => ({ id, name: names.get(id) ?? id }));
}

/** The heaviest workspaces the payload names, plus `other` when the rest have to fold into it. */
function workspaceList(ledger: UsageLedger, buckets: readonly UsageBucket[]): Array<{ id: string; name: string }> {
	const heaviest = ledger.workspaces();
	const recognised = new Set(heaviest);
	const folds = buckets.some(bucket => !recognised.has(bucket.workspace)) || heaviest.length > MAX_VIEW_WORKSPACES;
	// `other` takes one of the slots rather than being an extra, so the payload never names more than the cap.
	const kept = folds ? heaviest.slice(0, MAX_VIEW_WORKSPACES - 1) : heaviest;
	const ids = folds ? [...kept, FOLDED_WORKSPACE] : kept;
	return ids.map(id => ({ id, name: nameOfWorkspace(id) }));
}

function nameOfWorkspace(id: string): string {
	const name = path.basename(id);
	return name.length > 0 ? name : id;
}

/** The buckets as chart points, with every workspace outside the named ones counted into `other` once. */
function pointsOf(buckets: readonly UsageBucket[], workspaces: UsageHistoryView['workspaces'], agents: UsageHistoryView['agents']): UsagePoint[] {
	const workspaceAt = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
	const otherAt = workspaceAt.get(FOLDED_WORKSPACE) ?? -1;
	const agentAt = new Map(agents.map((agent, index) => [agent.id, index]));
	const sums = new Map<string, UsagePoint>();

	for (const bucket of buckets) {
		const w = workspaceAt.get(bucket.workspace) ?? otherAt;
		const a = agentAt.get(bucket.agent);
		if (w < 0 || a === undefined) {
			continue;
		}
		const key = `${bucket.key}\u0000${w}\u0000${a}`;
		const sum = sums.get(key);
		sums.set(key, {
			d: bucket.key,
			w,
			a,
			v: sum
				? [sum.v[0] + bucket.totals.input, sum.v[1] + bucket.totals.cacheRead, sum.v[2] + bucket.totals.cacheWrite, sum.v[3] + bucket.totals.output]
				: [bucket.totals.input, bucket.totals.cacheRead, bucket.totals.cacheWrite, bucket.totals.output],
		});
	}

	return [...sums.values()].sort((a, b) => a.d.localeCompare(b.d) || a.w - b.w || a.a - b.a);
}
