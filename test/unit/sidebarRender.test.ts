/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AgentCardState } from '../../src/ui/messages';
import { renderDocsView } from '../../src/ui/docs';
import { renderCards, renderNav, renderServerDown, renderServerHeader, renderServerSettings, renderUsageView } from '../../src/ui/render';
import type { ServerView, UsageHistoryView } from '../../src/ui/messages';

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

const SERVER: ServerView = { port: 8791, savedPort: 8791, url: 'http://127.0.0.1:8791/?token=abc', portFromEnv: false, alive: true };

describe('the page nav', () => {
	it('always offers Docs, right after Usage, and Server settings last when the host has a server', () => {
		const nav = renderNav('agents', { models: true, usage: true, server: true });
		const order = ['showAgents', 'showModels', 'showUsage', 'showDocs', 'showServer'].map(action => nav.indexOf(`data-action="${action}"`));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(nav).toContain('>Docs<');
		expect(nav).toContain('>Server settings<');
	});

	it('offers Docs even when the host fills no other tab, and no Server settings without a server', () => {
		const nav = renderNav('agents', { models: false, usage: false });
		expect(nav).toContain('data-action="showDocs"');
		expect(nav).not.toContain('data-action="showServer"');
	});

	it('marks the view being shown as pressed', () => {
		expect(renderNav('docs', { models: false, usage: false })).toMatch(/aria-pressed="true">Docs</);
		expect(renderNav('server', { models: false, usage: false, server: true })).toMatch(/aria-pressed="true">Server settings</);
	});
});

describe('the docs view', () => {
	const html = renderDocsView();
	const summaries = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map(match => match[1]);

	it('has three collapsible sections, all closed to begin with', () => {
		expect(html.match(/<details/g)).toHaveLength(3);
		expect(html).not.toMatch(/<details[^>]*\bopen\b/);
		expect(summaries).toEqual(['Server', 'VS Code Copilot client', 'Copilot CLI']);
	});

	it('explains the server and every server-level setting', () => {
		expect(html).toContain('127.0.0.1');
		expect(html).toContain('server.token');
		expect(html).toContain('acpHub.server.idleTimeoutMinutes');
		expect(html).toContain('acpHub.server.detached');
		expect(html).toContain('ACP_HUB_PORT');
		expect(html).toContain('Server settings');
	});

	it('names the command that syncs the models into Copilot', () => {
		expect(html).toContain('ACP Hub: Sync Models');
	});

	it('names the command that runs the server outside VS Code', () => {
		expect(html).toContain('<pre><code>node "$env:USERPROFILE\\.vscode\\extensions\\neometric.acp-hub-for-copilot-');
		expect(html).toContain('\\dist\\server.js"</code></pre>');
		expect(html).toContain('~/.vscode/extensions/neometric.acp-hub-for-copilot-');
	});

	it('says how to make the Copilot CLI work', () => {
		expect(html).toContain('providers.json');
		expect(html).toContain('COPILOT_PROVIDERS_CONFIG');
		expect(html).toContain('restart the CLI');
	});
});

describe('the server header', () => {
	it('links the address with the token and shows a green dot while the server is alive', () => {
		const html = renderServerHeader(SERVER);
		expect(html).toContain('status-dot alive');
		expect(html).toContain('href="http://127.0.0.1:8791/?token=abc"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('>127.0.0.1:8791<');
	});

	it('shows a red dot and no link when the server does not answer', () => {
		const html = renderServerHeader({ ...SERVER, alive: false });
		expect(html).toContain('status-dot down');
		expect(html).not.toContain('href=');
		expect(html).toContain('Server not reachable');
		expect(html).toContain('127.0.0.1:8791');
	});

	it('escapes what the server sends', () => {
		const html = renderServerHeader({ ...SERVER, url: 'http://127.0.0.1:8791/?token="><script>x</script>' });
		expect(html).not.toContain('<script>');
	});
});

describe('the server-down panel', () => {
	it('says the server is not running, with the reason and a button to start one', () => {
		const html = renderServerDown('The server on port 8791 is not running.');
		expect(html).toContain('status-dot down');
		expect(html).toContain('Server not running');
		expect(html).toContain('data-action="startServer"');
		expect(html).toContain('The server on port 8791 is not running.');
	});

	it('disables the button and says it is starting while it is', () => {
		const html = renderServerDown('The server is not running.', true);
		expect(html).toMatch(/data-action="startServer" disabled/);
		expect(html).toContain('Starting…');
	});

	it('names the terminal command and the autoStart setting, for a user who would rather not use the button', () => {
		const html = renderServerDown('The server is not running.');
		expect(html).toContain('paste this in a terminal');
		expect(html).toContain('<pre><code>node &quot;$env:USERPROFILE\\.vscode\\extensions\\neometric.acp-hub-for-copilot-');
		expect(html).toContain('\\dist\\server.js&quot;</code></pre>');
		expect(html).toContain('<code>acpHub.server.autoStart</code>');
	});

	it('escapes the reason', () => {
		expect(renderServerDown('<img onerror="x">')).not.toContain('<img');
	});
});

describe('the server settings view', () => {
	it('offers the saved port, a Save button, and a Restart button that says it ends the sessions', () => {
		const html = renderServerSettings(SERVER, undefined);
		expect(html).toMatch(/<input[^>]*data-server-port[^>]*value="8791"/);
		expect(html).toContain('data-action="saveServerPort"');
		expect(html).toContain('data-action="restartServer"');
		expect(html).toContain('ends any existing sessions');
	});

	it('shows a half-typed port instead of the saved one', () => {
		expect(renderServerSettings(SERVER, '90')).toMatch(/data-server-port[^>]*value="90"/);
	});

	it('says the running and the saved port differ until a restart', () => {
		const html = renderServerSettings({ ...SERVER, savedPort: 9100 }, undefined);
		expect(html).toContain('Running on 8791; 9100 is used after a restart.');
	});

	it('names no difference when the ports agree', () => {
		expect(renderServerSettings(SERVER, undefined)).not.toContain('is used after a restart');
	});

	it('disables the port when ACP_HUB_PORT names it', () => {
		const html = renderServerSettings({ ...SERVER, portFromEnv: true }, undefined);
		expect(html).toContain('ACP_HUB_PORT');
		expect(html).toMatch(/data-server-port[^>]*disabled/);
		expect(html).toMatch(/data-action="saveServerPort"[^>]*disabled/);
	});

	it('tells the user to sync the models again after a port change', () => {
		const html = renderServerSettings(SERVER, undefined);
		expect(html).toContain('ACP Hub: Sync Models');
		expect(html).toContain('providers.json');
	});
});

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

	it('says that only Claude reports cache writes', () => {
		const html = renderUsageView(view, { range: '7', agents: new Set(), workspaces: new Set() });
		expect(html).toContain('Codex and Google never report it');
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
