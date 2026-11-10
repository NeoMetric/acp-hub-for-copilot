import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import type { InstallState } from '../../src/core/installers';
import type { ControlSurface } from '../../src/engine/control/ControlService';
import type { UsageState } from '../../src/engine/chat/usage';
import { ControlPage } from '../../src/ui/controlPage';
import type { ControlState, ModelsSurface, UsageHistorySurface, UsageHistoryView } from '../../src/ui/messages';

function fakeAdapter(id: string): AgentAdapter {
	return {
		id,
		displayName: `Agent ${id}`,
		install: { kind: 'npm' },
		auth: id === 'a' ? [{ kind: 'api-key', label: 'Key of a', envVar: 'A_KEY', keyPrefix: 'sk-' }] : [],
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
		saveApiKey: async () => ({ ok: true }),
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

/** A page over a fake surface, with a listener that records every snapshot it publishes. */
function setup(overrides: Partial<ControlSurface> = {}, usage?: UsageHistorySurface) {
	const surface = fake(overrides);
	const host = { openExternal: vi.fn(async () => { }), copyToClipboard: vi.fn(async () => { }) };
	const page = new ControlPage(surface.control, host, undefined, usage);
	const states: ControlState[] = [];
	page.onState(state => { states.push(state); });
	const last = (): ControlState => states[states.length - 1];
	const card = (id: string) => last().agents.find(item => item.id === id)!;
	return { ...surface, ...host, page, states, last, card };
}

describe('ControlPage usage history', () => {
	const sample: UsageHistoryView = {
		retentionDays: 30,
		agents: [{ id: 'a', name: 'Agent a' }],
		workspaces: [{ id: '/repo', name: 'repo' }],
		days: [{ d: '2026-11-10', w: 0, a: 0, v: [1, 2, 3, 4] }],
		weeks: [],
		today: [],
		empty: false,
	};

	function history(): UsageHistorySurface {
		return { view: vi.fn(async () => sample), setRetentionDays: vi.fn(async () => { }), onDidChange: () => () => { } };
	}

	it('offers no usage view when the host has no ledger', async () => {
		expect((await setup().page.state()).usage).toBeUndefined();
	});

	it('carries the usage view in the snapshot', async () => {
		expect((await setup({}, history()).page.state()).usage).toEqual(sample);
	});

	it('asks the host for the retention the page chose, then redraws', async () => {
		const usage = history();
		const { page } = setup({}, usage);
		await page.handle({ type: 'setRetentionDays', days: 14 });
		expect(usage.setRetentionDays).toHaveBeenCalledWith(14);
		expect(usage.view).toHaveBeenCalled();
	});

	it('ignores a retention the page asks for when the host keeps no history', async () => {
		const { page } = setup();
		await expect(page.handle({ type: 'setRetentionDays', days: 14 })).resolves.toBeUndefined();
	});
});

describe('ControlPage API key', () => {
	it('offers a key field only for an agent that signs in with a key', async () => {
		const { page } = setup();
		const state = await page.state();
		expect(state.agents.find(item => item.id === 'a')?.apiKey).toEqual({ label: 'Key of a', keyPrefix: 'sk-' });
		expect(state.agents.find(item => item.id === 'b')?.apiKey).toBeUndefined();
	});

	it('saves the key through the surface and shows a refusal on the card', async () => {
		const saveApiKey = vi.fn(async (_id: string, key: string) => key ? { ok: true } : { ok: false, message: 'Enter the API key.' });
		const { page, card } = setup({ saveApiKey });

		await page.handle({ type: 'saveApiKey', agentId: 'a', key: 'sk-1' });
		expect(saveApiKey).toHaveBeenCalledWith('a', 'sk-1');
		expect(card('a').error).toBeUndefined();

		await page.handle({ type: 'saveApiKey', agentId: 'a', key: '' });
		expect(card('a').error).toBe('Enter the API key.');
	});
});

describe('ControlPage models', () => {
	const VIEW = { agents: [{ agentId: 'a', provider: { name: 'Agent a', default: 'Agent a' }, models: [{ value: 'm', name: 'M', default: 'M' }] }] };

	function withModels(overrides: Partial<ModelsSurface> = {}) {
		const models: ModelsSurface = {
			view: async () => VIEW,
			setProviderName: vi.fn(async () => 'provider saved'),
			setModelName: vi.fn(async () => 'model saved'),
			refresh: vi.fn(async () => 'refreshed'),
			...overrides,
		};
		const host = { openExternal: async () => { }, copyToClipboard: async () => { } };
		return { models, page: new ControlPage(fake().control, host, models) };
	}

	it('has no models in its state when the host offers none', async () => {
		const { page } = setup();
		expect((await page.state()).models).toBeUndefined();
	});

	it('draws the models and runs the three actions, showing each notice', async () => {
		const { page, models } = withModels();
		expect((await page.state()).models).toEqual(VIEW);

		await page.handle({ type: 'setProviderName', agentId: 'a', name: 'Mine' });
		expect(models.setProviderName).toHaveBeenCalledWith('a', 'Mine');
		expect((await page.state()).notice).toBe('provider saved');

		await page.handle({ type: 'setModelName', agentId: 'a', model: 'm', name: 'Mine' });
		expect(models.setModelName).toHaveBeenCalledWith('a', 'm', 'Mine');
		expect((await page.state()).notice).toBe('model saved');

		await page.handle({ type: 'refreshModels' });
		expect(models.refresh).toHaveBeenCalled();
		expect((await page.state()).notice).toBe('refreshed');
	});

	it('reports that it is refreshing until the refresh ends', async () => {
		let finish: (notice: string) => void = () => undefined;
		const { page } = withModels({ refresh: () => new Promise<string>(resolve => { finish = resolve; }) });
		const states: ControlState[] = [];
		page.onState(state => { states.push(state); });

		const running = page.handle({ type: 'refreshModels' });
		await vi.waitFor(() => expect(states.at(-1)?.refreshing).toBe(true));
		expect((await page.state()).refreshing).toBe(true);

		finish('done');
		await running;

		expect(states.at(-1)).toMatchObject({ refreshing: false, notice: 'done' });
	});

	it('shows a failure as the notice', async () => {
		const { page } = withModels({ refresh: async () => { throw new Error('disk full'); } });

		await page.handle({ type: 'refreshModels' });

		expect((await page.state()).notice).toBe('disk full');
	});
});

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

describe('ControlPage usage refresh', () => {
	const sample: UsageHistoryView = {
		retentionDays: 30, agents: [], workspaces: [], days: [], weeks: [], today: [], empty: true,
	};

	it('redraws when the ledger says a flush landed', async () => {
		let fire: (() => void) | undefined;
		const usage: UsageHistorySurface = {
			view: async () => sample,
			setRetentionDays: async () => { },
			onDidChange: listener => { fire = listener; return () => { }; },
		};
		const { page, states } = setup({}, usage);
		await page.handle({ type: 'ready' });
		const before = states.length;
		fire?.();
		await vi.waitFor(() => expect(states.length).toBeGreaterThan(before));
	});
});
