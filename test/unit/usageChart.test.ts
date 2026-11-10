/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { formatTokens, renderAreaChart, renderChartLegend, SERIES } from '../../src/ui/chart';

describe('the usage chart', () => {
	it('draws one stacked area per series', () => {
		const html = renderAreaChart([
			{ label: '2026-11-09', values: [10, 20, 0, 5] },
			{ label: '2026-11-10', values: [0, 40, 0, 15] },
		]);
		for (const series of SERIES) {
			expect(html).toContain(`class="${series.className}"`);
		}
		expect(html.match(/<path class="series-/g)).toHaveLength(4);
	});

	it('labels the axis with the peak of the stack', () => {
		expect(renderAreaChart([{ label: 'a', values: [10, 20, 0, 5] }])).toContain('>35<');
	});

	it('carries the four numbers of a point in its tooltip', () => {
		const html = renderAreaChart([{ label: '2026-11-10', values: [1, 2, 3, 4] }]);
		expect(html).toContain('<title>2026-11-10: 1 input, 2 cache read, 3 cache write, 4 output</title>');
	});

	it('says so when there is nothing to draw', () => {
		expect(renderAreaChart([])).toContain('No usage recorded yet.');
		expect(renderAreaChart([{ label: 'a', values: [0, 0, 0, 0] }])).toContain('No usage recorded yet.');
	});

	it('escapes a label that carries markup', () => {
		const html = renderAreaChart([{ label: '<b>&', values: [1, 0, 0, 0] }]);
		expect(html).not.toContain('<b>');
		expect(html).toContain('&lt;b&gt;&amp;');
	});

	it('gives each legend entry its own colour class and the total of the range', () => {
		const html = renderChartLegend([1000, 2000, 0, 500]);
		expect(html).toContain('data-series="cache-read"');
		expect(html).toContain('Cache read');
		expect(html).toContain('4k');
	});
});

describe('formatting tokens', () => {
	it('keeps a small count as it is, and shortens a large one', () => {
		expect(formatTokens(999)).toBe('999');
		expect(formatTokens(1500)).toBe('2k');
		expect(formatTokens(2_500_000)).toBe('2.5M');
		expect(formatTokens(0)).toBe('0');
	});
});
