/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The four token kinds a turn is counted in, as the page draws them. */
export interface TokenTotals {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

/** A turn whose chat had no folder to file it under. */
export const UNKNOWN_WORKSPACE = 'unknown';

/** What a day keeps once it holds more workspaces than it has room for. */
export const FOLDED_WORKSPACE = 'other';

export function emptyTotals(): TokenTotals {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
	return {
		input: a.input + b.input,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		output: a.output + b.output,
	};
}

export function isZero(totals: TokenTotals): boolean {
	return totals.input === 0 && totals.cacheRead === 0 && totals.cacheWrite === 0 && totals.output === 0;
}

/** The local day a moment falls in, as `YYYY-MM-DD`; local, so a turn never lands in a day the user does not recognise. */
export function localDayKey(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local hour a moment falls in, `0` to `23`. */
export function localHour(at: number): number {
	return new Date(at).getHours();
}

/** The Monday of the week a day belongs to, as `YYYY-MM-DD`, so every bucket of a week view names its week. */
export function weekStartOf(dayKey: string): string {
	const [year, month, day] = dayKey.split('-').map(Number);
	const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
	const backToMonday = (date.getDay() + 6) % 7;
	return localDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - backToMonday).getTime());
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
