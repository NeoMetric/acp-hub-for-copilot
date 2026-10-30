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
		removable: true,
		signedIn: 'yes',
		hasSavedKey: false,
		enabled: true,
		visible: true,
		settings: [],
		usage: { status: 'unsupported', windows: [] },
		...overrides,
	};
}

const open = new Set(['one']);

describe('renderCards', () => {
	it('keeps settings out of the card until its settings button is opened', () => {
		const settings = [{ key: 'idleTimeoutSeconds', label: 'Idle session timeout', description: '', type: 'number' as const, value: 120 }];
		const closed = renderCards([card({ settings })]);
		expect(closed).toContain('data-action="toggleSettings"');
		expect(closed).toContain('aria-expanded="false"');
		expect(closed).not.toContain('Idle session timeout');

		const expanded = renderCards([card({ settings })], open);
		expect(expanded).toContain('aria-expanded="true"');
		expect(expanded).toContain('Idle session timeout');
	});

	it('offers uninstall in the settings panel only for an installed agent the extension installed', () => {
		expect(renderCards([card()])).not.toContain('data-action="uninstall"');
		expect(renderCards([card()], open)).toContain('data-action="uninstall"');
		expect(renderCards([card({ removable: false })], open)).not.toContain('data-action="uninstall"');
		expect(renderCards([card({ install: 'not-installed' })], open)).not.toContain('data-action="uninstall"');
		expect(renderCards([card({ busy: 'Uninstalling...' })], open)).toMatch(/data-action="uninstall"[^>]*disabled/);
	});

	it('shows an install button for a not-installed agent', () => {
		const html = renderCards([card({ install: 'not-installed' })]);
		expect(html).toContain('data-action="install"');
		expect(html).toContain('Agent One');
	});

	it('shows an indeterminate progress bar during installation', () => {
		const html = renderCards([card({ install: 'installing' })]);
		expect(html).toContain('<progress aria-label="Installing agent">');
	});

	it('does not offer API key removal as browser account sign-out', () => {
		const html = renderCards([card({ signedIn: 'yes', hasSavedKey: false })]);
		expect(html).toContain('Signed in');
		expect(html).not.toContain('data-action="signOut"');
	});

	it('shows an unknown account status without assuming the agent is signed out', () => {
		const html = renderCards([card({ signedIn: 'unknown' })]);
		expect(html).toContain('Account status unknown');
		expect(html).toContain('Manage sign-in');
		expect(html).not.toContain('>Sign in</button>');
	});

	it('offers sign-in when the agent reports it is signed out', () => {
		const html = renderCards([card({ signedIn: 'no' })]);
		expect(html).toContain('>Sign in</button>');
	});

	it('offers API key removal when a key is saved', () => {
		const html = renderCards([card({ signedIn: 'yes', hasSavedKey: true })]);
		expect(html).toContain('Remove API key');
		expect(html).toContain('data-action="signOut"');
	});

	it('explains when usage is unsupported', () => {
		expect(renderCards([card()])).toContain('Usage is not supported');
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
		})], open);
		expect(html).toContain('type="checkbox" data-agent="one" data-key="flag"');
		expect(html).toContain('<option value="b" selected>');
		expect(html).toContain('value="x, y"');
	});

	it('places boolean settings inline and provides timeout explanations', () => {
		const html = renderCards([card({ settings: [
			{ key: 'dumpRequests', label: 'Dump requests', description: 'Debug', type: 'boolean', value: false },
			{ key: 'idleTimeoutSeconds', label: 'Idle session timeout', description: 'Session lifetime', type: 'number', value: 120 },
		] })], open);
		expect(html).toContain('class="setting setting-checkbox"');
		expect(html).toContain('aria-label="About Dump requests"');
		expect(html).toContain('aria-label="About Idle session timeout"');
		expect(html).toContain('Session lifetime');
	});

	it('explains cache metrics and authentication options', () => {
		const html = renderCards([card({
			settings: [{ key: 'authPreference', label: 'Auth preference', description: 'Choose credentials.', type: 'enum', value: 'auto', options: ['auto'], optionDescriptions: ['Use the available account.'] }],
			usage: { status: 'ok', windows: [{ label: 'Cumulative cache hit rate', usedPercent: 50 }] },
		})], open);
		expect(html).toContain('aria-label="About Auth preference"');
		expect(html).toContain('auto: Use the available account.');
		expect(html).toContain('aria-label="About Cumulative cache hit rate"');
		expect(html).toContain('token-weighted cache hit rate');
	});

	it('offers hidden supported agents for adding', () => {
		const html = renderCards([card({ visible: false })]);
		expect(html).toContain('+ Add agent');
		expect(html).toContain('data-action="addAgent"');
		expect(html).not.toContain('class="card"');
	});
});
