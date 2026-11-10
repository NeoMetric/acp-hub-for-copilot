/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AgentCardState } from '../../src/ui/messages';
import { renderCards, renderNav, renderUsageView } from '../../src/ui/render';
import type { UsageHistoryView } from '../../src/ui/messages';

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

	it('offers an API key beside the account sign-in, and the field only once it is opened', () => {
		const keyed = card({ signedIn: 'no', apiKey: { label: 'Anthropic API key', keyPrefix: 'sk-ant-' } });
		const closed = renderCards([keyed]);
		expect(closed).toContain('>Sign in</button>');
		expect(closed).toContain('data-action="showApiKey"');
		expect(closed).toContain('Use API key');
		expect(closed).not.toContain('type="password"');

		const entering = renderCards([keyed], new Set(), [], new Set(['one']));
		expect(entering).toContain('type="password"');
		expect(entering).toContain('placeholder="sk-ant-..."');
		expect(entering).toContain('data-action="saveApiKey"');
	});

	it('offers replacing a saved key, and nothing for an agent without key sign-in', () => {
		const saved = renderCards([card({ hasSavedKey: true, apiKey: { label: 'Key' } })]);
		expect(saved).toContain('Replace API key');
		expect(saved).toContain('Remove API key');
		expect(renderCards([card({ signedIn: 'no' })])).not.toContain('showApiKey');
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

	it('renders the settings for all agents above the cards', () => {
		const html = renderCards([card()], new Set(), [{ key: 'resume.transcriptDetail', label: 'Restored chat detail', description: '', type: 'enum', value: 'full', options: ['compact', 'full'] }]);
		expect(html.indexOf('Settings for all agents')).toBeGreaterThanOrEqual(0);
		expect(html.indexOf('Settings for all agents')).toBeLessThan(html.indexOf('class="card"'));
		expect(html).toContain('data-global="true"');
		expect(html).toContain('<option value="full" selected>');
	});

	it('offers hidden supported agents for adding', () => {
		const html = renderCards([card({ visible: false })]);
		expect(html).toContain('+ Add agent');
		expect(html).toContain('data-action="addAgent"');
		expect(html).not.toContain('class="card"');
	});
});

describe('the Usage view', () => {
	const view: UsageHistoryView = {
		retentionDays: 30,
		agents: [{ id: 'claude', name: 'Claude Agent' }, { id: 'codex', name: 'Codex Agent' }],
		workspaces: [{ id: '/repo/app', name: 'app' }, { id: '/repo/<b>&', name: '<b>&' }],
		days: [
			{ d: '2026-11-09', w: 0, a: 0, v: [10, 100, 0, 20] },
			{ d: '2026-11-09', w: 1, a: 1, v: [5, 0, 0, 5] },
			{ d: '2026-11-10', w: 0, a: 0, v: [1, 40, 0, 9] },
		],
		weeks: [{ d: '2026-11-09', w: 0, a: 0, v: [11, 140, 0, 29] }],
		today: [{ d: '09', w: 0, a: 0, v: [1, 40, 0, 9] }],
		empty: false,
	};

	const totalShown = (html: string): string => /class="legend-total">Total <strong>([^<]+)<\/strong>/.exec(html)?.[1] ?? '';

	it('draws the Usage tab beside Agents and Models', () => {
		expect(renderNav('usage', { models: true, usage: true })).toContain('data-action="showUsage"');
	});

	it('hides a tab the host cannot fill', () => {
		const nav = renderNav('agents', { models: false, usage: false });
		expect(nav).not.toContain('data-action="showUsage"');
		expect(nav).not.toContain('data-action="showModels"');
	});

	it('shows the retention field, the filters and the chart', () => {
		const html = renderUsageView(view, { range: '7', agents: new Set(), workspaces: new Set() });
		expect(html).toContain('data-action="setRetentionDays"');
		expect(html).toContain('data-agent-filter="claude"');
		expect(html).toContain('data-workspace-filter="/repo/app"');
		expect(html).toContain('<svg');
	});

	it('sums only the selected agent and workspace into the chart', () => {
		expect(totalShown(renderUsageView(view, { range: '7', agents: new Set(), workspaces: new Set() }))).toBe('190');
		expect(totalShown(renderUsageView(view, { range: '7', agents: new Set(['claude']), workspaces: new Set() }))).toBe('180');
		expect(totalShown(renderUsageView(view, { range: '7', agents: new Set(['codex']), workspaces: new Set() }))).toBe('10');
	});

	it('escapes a workspace path that carries markup', () => {
		const html = renderUsageView(view, { range: '7', agents: new Set(), workspaces: new Set() });
		expect(html).not.toContain('<b>');
		expect(html).toContain('&lt;b&gt;&amp;');
	});

	it('explains an empty history once', () => {
		const empty = { ...view, days: [], weeks: [], today: [], empty: true };
		expect(renderUsageView(empty, { range: '30', agents: new Set(), workspaces: new Set() }))
			.toContain('Recording starts now; usage before this update was never stored.');
	});
});

describe('the Usage view ranges', () => {
	/** Ten days, two workspaces, one agent: twenty points, three tokens a day. */
	const many: UsageHistoryView = {
		retentionDays: 30,
		agents: [{ id: 'claude', name: 'Claude Agent' }],
		workspaces: [{ id: '/a', name: 'a' }, { id: '/b', name: 'b' }],
		days: Array.from({ length: 10 }, (_, index) => {
			const day = `2026-11-${String(index + 1).padStart(2, '0')}`;
			return [{ d: day, w: 0, a: 0, v: [1, 0, 0, 0] as [number, number, number, number] }, { d: day, w: 1, a: 0, v: [2, 0, 0, 0] as [number, number, number, number] }];
		}).flat(),
		weeks: [],
		today: [],
		empty: false,
	};

	const totalShown = (html: string): string => /class="legend-total">Total <strong>([^<]+)<\/strong>/.exec(html)?.[1] ?? '';

	it('keeps the days of the range, not the last rows of it', () => {
		expect(totalShown(renderUsageView(many, { range: '30', agents: new Set(), workspaces: new Set() }))).toBe('30');
		expect(totalShown(renderUsageView(many, { range: '7', agents: new Set(), workspaces: new Set() }))).toBe('21');
	});

	it('leaves out a selected workspace the snapshot no longer has, instead of emptying the chart', () => {
		expect(totalShown(renderUsageView(many, { range: '30', agents: new Set(), workspaces: new Set(['/gone']) }))).toBe('30');
	});

	it('still honours a selection the snapshot does have', () => {
		expect(totalShown(renderUsageView(many, { range: '30', agents: new Set(), workspaces: new Set(['/b']) }))).toBe('20');
	});
});
