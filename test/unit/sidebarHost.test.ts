/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import type { InstallState } from '../../src/core/installers';
import type { ControlSurface } from '../../src/engine/control/ControlService';
import { SidebarHost, type SidebarPageDeps } from '../../src/sidebar/host';
import type { AgentCardState, ToWebview } from '../../src/ui/messages';

function fakeAdapter(id: string): AgentAdapter {
	return {
		id,
		displayName: `Agent ${id}`,
		install: { kind: 'npm' },
		settings: [{ key: 'level', type: 'string', label: 'Level', description: '', default: 'low' }],
	} as unknown as AgentAdapter;
}

function setup(overrides: Partial<ControlSurface> = {}) {
	const installed = new Map<string, InstallState>([['a', 'not-installed'], ['b', 'not-installed']]);
	const control: ControlSurface = {
		agents: () => [fakeAdapter('a'), fakeAdapter('b')],
		visibleAgents: () => ['a', 'b'],
		saveVisibleAgents: async () => { },
		installState: async id => installed.get(id) ?? 'not-installed',
		install: vi.fn(async (id: string) => { installed.set(id, 'installed'); }),
		uninstall: vi.fn(async (id: string) => { installed.set(id, 'not-installed'); return true; }),
		isSignedIn: async () => undefined,
		hasSavedKey: async () => false,
		signIn: async () => ({ ok: true }),
		signOut: async () => { },
		readSettings: () => ({}),
		writeSetting: vi.fn(async () => { }),
		readGlobalSetting: () => undefined,
		writeGlobalSetting: vi.fn(async () => { }),
		isEnabled: () => true,
		setEnabled: async () => { },
		usage: () => ({ status: 'idle', extraWindows: [] }),
		refreshUsage: async () => { },
		refresh: () => { },
		onUsageChange: () => ({ dispose() { } }),
		...overrides,
	};
	const page: SidebarPageDeps = {
		openExternal: vi.fn(async () => { }),
		copyToClipboard: vi.fn(async () => { }),
		assetUri: path => ({ path }) as never,
	};

	const posted: AgentCardState[][] = [];
	let receive: ((message: unknown) => void) | undefined;
	const host = new SidebarHost(control, page);
	const webview = {
		options: {},
		html: '',
		cspSource: 'csp',
		asWebviewUri: (uri: { path: string }) => uri.path,
		onDidReceiveMessage: (handler: (message: unknown) => void) => { receive = handler; return { dispose() { } }; },
		postMessage: async (message: ToWebview) => { posted.push(message.agents); return true; },
	};
	host.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() { } }) } as never);

	const last = () => posted[posted.length - 1];
	const card = (id: string) => last().find(item => item.id === id)!;
	return { host, control, page, posted, webview, last, card, receive: (message: unknown) => receive?.(message) };
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

	it('takes a page action over the postMessage channel', async () => {
		const { receive, control, posted } = setup();
		receive({ type: 'install', agentId: 'a' });
		await vi.waitFor(() => expect(control.install).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(posted.at(-1)!.find(item => item.id === 'a')!.install).toBe('installed'));
		expect(posted).toHaveLength(2);
	});

	it('shows a sign-in page, opens it, and copies or reopens only the stored URL', async () => {
		const { host, page, card } = setup();
		host.showSignInUrl('a', { url: 'https://example.com/device', message: 'Enter code ABCD' });
		await host.handleMessage({ type: 'ready' });
		expect(page.openExternal).toHaveBeenCalledWith('https://example.com/device');
		expect(card('a').signInUrl).toEqual({ url: 'https://example.com/device', message: 'Enter code ABCD' });

		await host.handleMessage({ type: 'copySignInUrl', agentId: 'a' });
		expect(page.copyToClipboard).toHaveBeenCalledWith('https://example.com/device');
		await host.handleMessage({ type: 'copySignInUrl', agentId: 'b' });
		expect(page.copyToClipboard).toHaveBeenCalledTimes(1);

		host.showSignInUrl('a', undefined);
		await host.handleMessage({ type: 'ready' });
		expect(card('a').signInUrl).toBeUndefined();
	});

	it('writes a known global setting and ignores an unknown one', async () => {
		const { host, control } = setup();
		await host.handleMessage({ type: 'setGlobalSetting', key: 'resume.transcriptDetail', value: 'full' });
		await host.handleMessage({ type: 'setGlobalSetting', key: 'somethingElse', value: 'x' });
		expect(control.writeGlobalSetting).toHaveBeenCalledTimes(1);
		expect(control.writeGlobalSetting).toHaveBeenCalledWith('resume.transcriptDetail', 'full');
	});

	it('initially shows installed agents and persists additions and removals', async () => {
		const save = vi.fn(async (_ids: string[]) => { });
		const { host, last } = setup({
			visibleAgents: () => undefined,
			saveVisibleAgents: save,
			installState: async id => id === 'a' ? 'installed' : 'not-installed',
		});
		await host.handleMessage({ type: 'ready' });
		expect(last().filter(item => item.visible).map(item => item.id)).toEqual(['a']);
		await host.handleMessage({ type: 'addAgent', agentId: 'b' });
		expect(save).toHaveBeenLastCalledWith(['a', 'b']);
		await host.handleMessage({ type: 'removeAgent', agentId: 'a' });
		expect(save).toHaveBeenLastCalledWith(['b']);
		expect(last().filter(item => item.visible).map(item => item.id)).toEqual(['b']);
	});

	it('installs once and posts busy then installed', async () => {
		const { host, control, posted, card } = setup();
		await host.handleMessage({ type: 'install', agentId: 'a' });
		expect(control.install).toHaveBeenCalledTimes(1);
		expect(posted.length).toBe(2);
		expect(posted[0].find(item => item.id === 'a')!.install).toBe('installing');
		expect(posted[0].find(item => item.id === 'a')!.busy).toBeTruthy();
		expect(card('a').install).toBe('installed');
		expect(card('a').busy).toBeUndefined();
	});

	it('uninstalls an agent and shows it as not installed', async () => {
		const { host, control, card } = setup();
		await host.handleMessage({ type: 'install', agentId: 'a' });
		expect(card('a').removable).toBe(true);
		await host.handleMessage({ type: 'uninstall', agentId: 'a' });
		expect(control.uninstall).toHaveBeenCalledWith('a');
		expect(card('a').install).toBe('not-installed');
		expect(card('a').busy).toBeUndefined();
	});

	it('shows an uninstall failure on that card only', async () => {
		const { host, card } = setup({ uninstall: async () => { throw new Error('file in use'); } });
		await host.handleMessage({ type: 'uninstall', agentId: 'a' });
		expect(card('a').error).toContain('file in use');
		expect(card('b').error).toBeUndefined();
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

	it('serializes rapid enable changes so the last choice wins', async () => {
		let finish: () => void = () => { };
		let enabled = true;
		const setEnabled = vi.fn(async (_id: string, value: boolean) => {
			if (!value) { await new Promise<void>(resolve => { finish = resolve; }); }
			enabled = value;
		});
		const { host, card } = setup({ setEnabled, isEnabled: () => enabled });
		const first = host.handleMessage({ type: 'setEnabled', agentId: 'a', enabled: false });
		await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledTimes(1));
		const second = host.handleMessage({ type: 'setEnabled', agentId: 'a', enabled: true });
		expect(setEnabled).toHaveBeenCalledTimes(1);
		finish();
		await Promise.all([first, second]);
		expect(enabled).toBe(true);
		expect(card('a').enabled).toBe(true);
	});

	it('discards an older sidebar refresh that finishes late', async () => {
		let finish: () => void = () => { };
		let calls = 0;
		const { host, posted } = setup({ isSignedIn: async () => {
			if (++calls === 1) { await new Promise<void>(resolve => { finish = resolve; }); }
			return true;
		} });
		const first = host.handleMessage({ type: 'ready' });
		await vi.waitFor(() => expect(calls).toBe(1));
		await host.handleMessage({ type: 'ready' });
		finish();
		await first;
		expect(posted).toHaveLength(1);
	});

	it('writes a changed setting through', async () => {
		const { host, control } = setup();
		await host.handleMessage({ type: 'setSetting', agentId: 'a', key: 'level', value: 'high' });
		expect(control.writeSetting).toHaveBeenCalledWith('a', 'level', 'high');
	});

	it('ignores an unknown agent id', async () => {
		const { host, control, posted } = setup();
		await host.handleMessage({ type: 'install', agentId: 'nope' });
		await host.handleMessage({ type: 'setSetting', agentId: 'nope', key: 'level', value: 'x' });
		expect(control.install).not.toHaveBeenCalled();
		expect(control.writeSetting).not.toHaveBeenCalled();
		expect(posted.length).toBe(0);
	});

	it('shows a failed sign-in on the card', async () => {
		const { host, card } = setup({ signIn: async () => ({ ok: false, message: 'cancelled' }) });
		await host.handleMessage({ type: 'signIn', agentId: 'a' });
		expect(card('a').error).toBe('cancelled');
	});
});
