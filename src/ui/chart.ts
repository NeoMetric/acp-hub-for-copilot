/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { escapeHtml } from './html';

/** The four token kinds of a point, in the order the chart stacks them. */
export const SERIES = [
	{ key: 'input', label: 'Input', className: 'series-input' },
	{ key: 'cacheRead', label: 'Cache read', className: 'series-cache-read' },
	{ key: 'cacheWrite', label: 'Cache write', className: 'series-cache-write' },
	{ key: 'output', label: 'Output', className: 'series-output' },
] as const;

/** One column of the chart: what its point spent, in the order of {@link SERIES}. */
export interface ChartPoint {
	readonly label: string;
	readonly values: readonly [number, number, number, number];
}

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 44;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

/** A token count as the page shows it: short enough for an axis. */
export function formatTokens(tokens: number): string {
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

function totalOf(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0);
}

/**
 * The stacked area chart of a range: one filled area per token kind, so the
 * height at any point is what the point spent in all four together. The colours
 * come from the stylesheet's series classes, which is what keeps the chart
 * legible under either VS Code theme.
 */
export function renderAreaChart(points: readonly ChartPoint[], options: { readonly height?: number } = {}): string {
	const height = options.height ?? HEIGHT;
	const peak = points.reduce((highest, point) => Math.max(highest, totalOf(point.values)), 0);
	if (points.length === 0 || peak === 0) {
		return '<div class="note">No usage recorded yet.</div>';
	}

	const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
	const plotHeight = height - PAD_TOP - PAD_BOTTOM;
	const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
	const x = (index: number): number => points.length > 1 ? PAD_LEFT + index * step : PAD_LEFT + plotWidth / 2;
	const y = (tokens: number): number => PAD_TOP + plotHeight - (tokens / peak) * plotHeight;

	const paths = SERIES.map((series, seriesIndex) => {
		const lower: number[] = [];
		const upper: number[] = [];
		for (const point of points) {
			const below = totalOf(point.values.slice(0, seriesIndex));
			lower.push(below);
			upper.push(below + point.values[seriesIndex]!);
		}
		if (points.length === 1) {
			// A lone point has no width to fill between, so the area would collapse to a line: draw a bar.
			const barWidth = 48;
			return `<rect class="${series.className}" x="${(x(0) - barWidth / 2).toFixed(1)}" y="${y(upper[0]!).toFixed(1)}" width="${barWidth}" height="${(y(lower[0]!) - y(upper[0]!)).toFixed(1)}"></rect>`;
		}
		const along = (values: readonly number[], from: number, to: number, stride: number): string => {
			const steps: string[] = [];
			for (let index = from; index !== to; index += stride) {
				steps.push(`${x(index).toFixed(1)},${y(values[index]!).toFixed(1)}`);
			}
			return steps.join(' ');
		};
		const top = along(upper, 0, points.length, 1);
		const back = along(lower, points.length - 1, -1, -1);
		return `<path class="${series.className}" d="M ${top} L ${back} Z"></path>`;
	}).join('');

	const columns = points.map((point, index) => {
		const width = Math.max(step, 12);
		const left = Math.max(PAD_LEFT, x(index) - width / 2);
		const title = `${escapeHtml(point.label)}: ${point.values[0]} input, ${point.values[1]} cache read, ${point.values[2]} cache write, ${point.values[3]} output`;
		return `<rect class="chart-column" x="${left.toFixed(1)}" y="${PAD_TOP}" width="${width.toFixed(1)}" height="${plotHeight.toFixed(1)}"><title>${title}</title></rect>`;
	}).join('');

	const axis = [peak, peak / 2, 0].map(value =>
		`<text class="chart-axis" x="${PAD_LEFT - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatTokens(Math.round(value)))}</text>`,
	).join('');

	const labelled = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((index, position, all) => all.indexOf(index) === position);
	const labels = labelled.map(index =>
		`<text class="chart-axis" x="${x(index).toFixed(1)}" y="${height - 4}" text-anchor="middle">${escapeHtml(points[index]!.label)}</text>`,
	).join('');

	return `<svg class="usage-chart" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="Tokens spent over time">`
		+ axis + labels + paths + columns
		+ '</svg>';
}

/** The legend under the chart: a colour swatch, the name of the series, and what the range spent of it. */
export function renderChartLegend(totals: readonly [number, number, number, number]): string {
	const rows = SERIES.map((series, index) =>
		`<span class="legend-entry" data-series="${series.className.replace('series-', '')}">`
		+ `<span class="legend-swatch ${series.className}"></span>${escapeHtml(series.label)} `
		+ `<strong>${escapeHtml(formatTokens(totals[index] ?? 0))}</strong></span>`,
	).join('');
	return `<div class="legend">${rows}<span class="legend-total">Total <strong>${escapeHtml(formatTokens(totalOf(totals)))}</strong></span></div>`;
}
