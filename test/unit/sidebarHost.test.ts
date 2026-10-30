/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import type { InstallState } from '../../src/core/installers';
import { SidebarHost, type SidebarDeps } from '../../src/sidebar/host';
import type { AgentCardState, ToWebview } from '../../src/sidebar/messages';

function fakeAdapter(id: string): AgentAdapter {
	return {
		id,
		displayName: `Agent ${id}`,
		settings: [{ key: 'level', type: 'string', label: 'Level', description: '', default: 'low' }],
	} as unknown as AgentAdapter;
}

function setup(overrides: Partial<SidebarDeps> = {}) {
	const installed = new Map<string, InstallState>([['a', 'not-installed'], ['b', 'not-installed']]);
	const deps: SidebarDeps = {
		listAdapters: () => [fakeAdapter('a'), fakeAdapter('b')],
		getInstallState: async id => installed.get(id) ?? 'not-installed',
		install: vi.fn(async (id: string) => { installed.set(id, 'installed'); }),
		isSignedIn: async () => undefined,
		signIn: async () => ({ ok: true }),
		signOut: async () => { },
		readSettings: () => ({}),
		writeSetting: vi.fn(async () => { }),
		isEnabled: () => true,
		setEnabled: async () => { },
		getUsage: () => ({ status: 'idle', extraWindows: [] }),
		refreshUsage: async () => { },
		onUsageChange: () => ({ dispose() { } }),
		assetUri: path => ({ path }) as never,
		...overrides,
	};

	const posted: AgentCardState[][] = [];
	const host = new SidebarHost(deps);
	const webview = {
		options: {},
		html: '',
		cspSource: 'csp',
		asWebviewUri: (uri: { path: string }) => uri.path,
		onDidReceiveMessage: () => ({ dispose() { } }),
		postMessage: async (message: ToWebview) => { posted.push(message.agents); return true; },
	};
	host.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() { } }) } as never);

	const last = () => posted[posted.length - 1];
	const card = (id: string) => last().find(item => item.id === id)!;
	return { host, deps, posted, webview, last, card };
}

describe('SidebarHost', () => {
	it('builds a strict page for the webview', () => {
		const { webview } = setup();
		expect(webview.html).toContain(`script-src 'nonce-`);
		expect(webview.html).not.toContain('<script>');
	});

	it('posts a state with every adapter on ready', async () => {
		const { host, last } = setup();
		await host.handleMessage({ type: 'ready' });
		expect(last().map(item => item.id)).toEqual(['a', 'b']);
		expect(last()[0].settings[0].value).toBe('low');
	});

	it('installs once and posts busy then installed', async () => {
		const { host, deps, posted, card } = setup();
		await host.handleMessage({ type: 'install', agentId: 'a' });
		expect(deps.install).toHaveBeenCalledTimes(1);
		expect(posted.length).toBe(2);
		expect(posted[0].find(item => item.id === 'a')!.install).toBe('installing');
		expect(posted[0].find(item => item.id === 'a')!.busy).toBeTruthy();
		expect(card('a').install).toBe('installed');
		expect(card('a').busy).toBeUndefined();
	});

	it('shows an install failure on that card only', async () => {
		const { host, card } = setup({ install: async () => { throw new Error('no network'); } });
		await host.handleMessage({ type: 'install', agentId: 'a' });
		expect(card('a').error).toContain('no network');
		expect(card('a').install).toBe('not-installed');
		expect(card('b').error).toBeUndefined();
	});

	it('ignores a second install while one is running', async () => {
		let finish: () => void = () => { };
		const install = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
		const { host } = setup({ install });
		const first = host.handleMessage({ type: 'install', agentId: 'a' });
		await host.handleMessage({ type: 'install', agentId: 'a' });
		await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
		await host.handleMessage({ type: 'install', agentId: 'a' });
		finish();
		await first;
		expect(install).toHaveBeenCalledTimes(1);
	});

	it('writes a changed setting through', async () => {
		const { host, deps } = setup();
		await host.handleMessage({ type: 'setSetting', agentId: 'a', key: 'level', value: 'high' });
		expect(deps.writeSetting).toHaveBeenCalledWith('a', 'level', 'high');
	});

	it('ignores an unknown agent id', async () => {
		const { host, deps, posted } = setup();
		await host.handleMessage({ type: 'install', agentId: 'nope' });
		await host.handleMessage({ type: 'setSetting', agentId: 'nope', key: 'level', value: 'x' });
		expect(deps.install).not.toHaveBeenCalled();
		expect(deps.writeSetting).not.toHaveBeenCalled();
		expect(posted.length).toBe(0);
	});

	it('shows a failed sign-in on the card', async () => {
		const { host, card } = setup({ signIn: async () => ({ ok: false, message: 'cancelled' }) });
		await host.handleMessage({ type: 'signIn', agentId: 'a' });
		expect(card('a').error).toBe('cancelled');
	});
});
