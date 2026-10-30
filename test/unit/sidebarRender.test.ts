/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AgentCardState } from '../../src/sidebar/messages';
import { renderCards } from '../../src/sidebar/render';

function card(overrides: Partial<AgentCardState> = {}): AgentCardState {
	return {
		id: 'one',
		displayName: 'Agent One',
		install: 'installed',
		signedIn: 'yes',
		enabled: true,
		settings: [],
		usage: { status: 'unsupported', windows: [] },
		...overrides,
	};
}

describe('renderCards', () => {
	it('shows an install button for a not-installed agent', () => {
		const html = renderCards([card({ install: 'not-installed' })]);
		expect(html).toContain('data-action="install"');
		expect(html).toContain('Agent One');
	});

	it('draws a usage bar as wide as the used percent', () => {
		const html = renderCards([card({
			usage: { status: 'ok', windows: [{ label: '5h', usedPercent: 40, resets: 'in 2h' }], plan: 'Pro' },
		})]);
		expect(html).toContain('width:40%');
		expect(html).toContain('resets in 2h');
		expect(html).toContain('Plan: Pro');
	});

	it('escapes text from the agent', () => {
		const html = renderCards([card({ error: '<script>alert(1)</script>' })]);
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('renders inputs for each setting type', () => {
		const html = renderCards([card({
			settings: [
				{ key: 'flag', label: 'Flag', description: '', type: 'boolean', value: true },
				{ key: 'mode', label: 'Mode', description: '', type: 'enum', value: 'b', options: ['a', 'b'] },
				{ key: 'list', label: 'List', description: '', type: 'string-list', value: ['x', 'y'] },
			],
		})]);
		expect(html).toContain('type="checkbox" data-agent="one" data-key="flag"');
		expect(html).toContain('<option value="b" selected>');
		expect(html).toContain('value="x, y"');
	});

	it('mentions the registry in the add agent section', () => {
		expect(renderCards([])).toContain('More agents from the ACP registry come in a future release.');
	});
});
