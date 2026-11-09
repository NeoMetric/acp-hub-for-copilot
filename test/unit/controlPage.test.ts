import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import type { InstallState } from '../../src/core/installers';
import type { ControlSurface } from '../../src/engine/control/ControlService';
import type { UsageState } from '../../src/engine/chat/usage';
import { ControlPage } from '../../src/ui/controlPage';
import type { ControlState } from '../../src/ui/messages';

function fakeAdapter(id: string): AgentAdapter {
	return {
		id,
		displayName: `Agent ${id}`,
		install: { kind: 'npm' },
		settings: [{ key: 'level', type: 'string', label: 'Level', description: '', default: 'low' }],
	} as unknown as AgentAdapter;
}

function fake(overrides: Partial<ControlSurface> = {}) {
	let usage: UsageState = { status: 'idle', extraWindows: [] };
	const listeners: Array<(agentId: string) => void> = [];
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
		usage: () => usage,
		refreshUsage: async () => { },
		refresh: () => { },
		onUsageChange: listener => { listeners.push(listener); return { dispose() { } }; },
		...overrides,
	};
	const read = (next: UsageState) => {
		usage = next;
		listeners.forEach(listener => listener('a'));
	};
	return { control, read };
}

/** A page over the fake surface, with a listener that records every snapshot it publishes. */
function setup(overrides: Partial<ControlSurface> = {}) {
	const surface = fake(overrides);
	const host = { openExternal: vi.fn(async () => { }), copyToClipboard: vi.fn(async () => { }) };
	const page = new ControlPage(surface.control, host);
	const states: ControlState[] = [];
	page.onState(state => { states.push(state); });
	const last = (): ControlState => states[states.length - 1];
	const card = (id: string) => last().agents.find(item => item.id === id)!;
	return { ...surface, ...host, page, states, last, card };
}

describe('ControlPage', () => {
	it('drops the sign-in complaint once a usage read proves the account', async () => {
		const { page, read } = setup({ signIn: async () => ({ ok: false, message: 'Run this in a terminal.' }) });

		await page.handle({ type: 'signIn', agentId: 'a' });
		expect((await page.state()).agents[0].error).toBe('Run this in a terminal.');

		read({ status: 'ok', extraWindows: [], signedIn: true });
		expect((await page.state()).agents[0].error).toBeUndefined();
	});

	it('keeps the complaint while a read proves nothing', async () => {
		const { page, read } = setup({ signIn: async () => ({ ok: false, message: 'Run this in a terminal.' }) });

		await page.handle({ type: 'signIn', agentId: 'a' });
		read({ status: 'unavailable', extraWindows: [] });
		expect((await page.state()).agents[0].error).toBe('Run this in a terminal.');
	});

	it('publishes a state with every adapter on ready', async () => {
		const { page, last } = setup();

		await page.handle({ type: 'ready' });
		expect(last().agents.map(item => item.id)).toEqual(['a', 'b']);
		expect(last().agents[0].settings[0].value).toBe('low');
	});

	it('shows a sign-in page, opens it, and copies or reopens only the stored URL', async () => {
		const { page, openExternal, copyToClipboard, card } = setup();

		page.showSignInUrl('a', { url: 'https://example.com/device', message: 'Enter code ABCD' });
		await page.handle({ type: 'ready' });
		expect(openExternal).toHaveBeenCalledWith('https://example.com/device');
		expect(card('a').signInUrl).toEqual({ url: 'https://example.com/device', message: 'Enter code ABCD' });

		await page.handle({ type: 'copySignInUrl', agentId: 'a' });
		expect(copyToClipboard).toHaveBeenCalledWith('https://example.com/device');
		await page.handle({ type: 'copySignInUrl', agentId: 'b' });
		expect(copyToClipboard).toHaveBeenCalledTimes(1);

		page.showSignInUrl('a', undefined);
		await page.handle({ type: 'ready' });
		expect(card('a').signInUrl).toBeUndefined();
	});

	it('writes a known global setting and ignores an unknown one', async () => {
		const { page, control } = setup();

		await page.handle({ type: 'setGlobalSetting', key: 'resume.transcriptDetail', value: 'full' });
		await page.handle({ type: 'setGlobalSetting', key: 'somethingElse', value: 'x' });
		expect(control.writeGlobalSetting).toHaveBeenCalledTimes(1);
		expect(control.writeGlobalSetting).toHaveBeenCalledWith('resume.transcriptDetail', 'full');
	});

	it('initially shows installed agents and persists additions and removals', async () => {
		const save = vi.fn(async (_ids: string[]) => { });
		const { page, last } = setup({
			visibleAgents: () => undefined,
			saveVisibleAgents: save,
			installState: async id => id === 'a' ? 'installed' : 'not-installed',
		});

		await page.handle({ type: 'ready' });
		expect(last().agents.filter(item => item.visible).map(item => item.id)).toEqual(['a']);
		await page.handle({ type: 'addAgent', agentId: 'b' });
		expect(save).toHaveBeenLastCalledWith(['a', 'b']);
		await page.handle({ type: 'removeAgent', agentId: 'a' });
		expect(save).toHaveBeenLastCalledWith(['b']);
		expect(last().agents.filter(item => item.visible).map(item => item.id)).toEqual(['b']);
	});

	it('installs once and publishes busy then installed', async () => {
		const { page, control, states, card } = setup();

		await page.handle({ type: 'install', agentId: 'a' });
		expect(control.install).toHaveBeenCalledTimes(1);
		expect(states.length).toBe(2);
		expect(states[0].agents.find(item => item.id === 'a')!.install).toBe('installing');
		expect(states[0].agents.find(item => item.id === 'a')!.busy).toBeTruthy();
		expect(card('a').install).toBe('installed');
		expect(card('a').busy).toBeUndefined();
	});

	it('uninstalls an agent and shows it as not installed', async () => {
		const { page, control, card } = setup();

		await page.handle({ type: 'install', agentId: 'a' });
		expect(card('a').removable).toBe(true);
		await page.handle({ type: 'uninstall', agentId: 'a' });
		expect(control.uninstall).toHaveBeenCalledWith('a');
		expect(card('a').install).toBe('not-installed');
		expect(card('a').busy).toBeUndefined();
	});

	it('shows an uninstall failure on that card only', async () => {
		const { page, card } = setup({ uninstall: async () => { throw new Error('file in use'); } });

		await page.handle({ type: 'uninstall', agentId: 'a' });
		expect(card('a').error).toContain('file in use');
		expect(card('b').error).toBeUndefined();
	});

	it('shows an install failure on that card only', async () => {
		const { page, card } = setup({ install: async () => { throw new Error('no network'); } });

		await page.handle({ type: 'install', agentId: 'a' });
		expect(card('a').error).toContain('no network');
		expect(card('a').install).toBe('not-installed');
		expect(card('b').error).toBeUndefined();
	});

	it('ignores a second install while one is running', async () => {
		let finish: () => void = () => { };
		const install = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
		const { page } = setup({ install });

		const first = page.handle({ type: 'install', agentId: 'a' });
		await page.handle({ type: 'install', agentId: 'a' });
		await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
		await page.handle({ type: 'install', agentId: 'a' });
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
		const { page, card } = setup({ setEnabled, isEnabled: () => enabled });

		const first = page.handle({ type: 'setEnabled', agentId: 'a', enabled: false });
		await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledTimes(1));
		const second = page.handle({ type: 'setEnabled', agentId: 'a', enabled: true });
		expect(setEnabled).toHaveBeenCalledTimes(1);
		finish();
		await Promise.all([first, second]);
		expect(enabled).toBe(true);
		expect(card('a').enabled).toBe(true);
	});

	it('discards an older refresh that finishes late', async () => {
		let finish: () => void = () => { };
		let calls = 0;
		const { page, states } = setup({
			isSignedIn: async () => {
				if (++calls === 1) { await new Promise<void>(resolve => { finish = resolve; }); }
				return true;
			},
		});

		const first = page.handle({ type: 'ready' });
		await vi.waitFor(() => expect(calls).toBe(1));
		await page.handle({ type: 'ready' });
		finish();
		await first;
		expect(states).toHaveLength(1);
	});

	it('writes a changed setting through', async () => {
		const { page, control } = setup();

		await page.handle({ type: 'setSetting', agentId: 'a', key: 'level', value: 'high' });
		expect(control.writeSetting).toHaveBeenCalledWith('a', 'level', 'high');
	});

	it('ignores an unknown agent id', async () => {
		const { page, control, states } = setup();

		await page.handle({ type: 'install', agentId: 'nope' });
		await page.handle({ type: 'setSetting', agentId: 'nope', key: 'level', value: 'x' });
		expect(control.install).not.toHaveBeenCalled();
		expect(control.writeSetting).not.toHaveBeenCalled();
		expect(states).toHaveLength(0);
	});

	it('shows a failed sign-in on the card', async () => {
		const { page, card } = setup({ signIn: async () => ({ ok: false, message: 'cancelled' }) });

		await page.handle({ type: 'signIn', agentId: 'a' });
		expect(card('a').error).toBe('cancelled');
	});
});
