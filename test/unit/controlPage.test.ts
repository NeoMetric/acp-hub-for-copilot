import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import type { ControlSurface } from '../../src/engine/control/ControlService';
import type { UsageState } from '../../src/engine/chat/usage';
import { ControlPage } from '../../src/ui/controlPage';

function fake(signIn: ControlSurface['signIn']) {
	let usage: UsageState = { status: 'idle', extraWindows: [] };
	const listeners: Array<(agentId: string) => void> = [];
	const control: ControlSurface = {
		agents: () => [{ id: 'a', displayName: 'Agent A', install: { kind: 'npm' }, settings: [] } as unknown as AgentAdapter],
		visibleAgents: () => ['a'],
		saveVisibleAgents: async () => { },
		installState: async () => 'installed',
		install: async () => { },
		uninstall: async () => true,
		isSignedIn: async () => undefined,
		hasSavedKey: async () => false,
		signIn,
		signOut: async () => { },
		readSettings: () => ({}),
		writeSetting: async () => { },
		readGlobalSetting: () => undefined,
		writeGlobalSetting: async () => { },
		isEnabled: () => true,
		setEnabled: async () => { },
		usage: () => usage,
		refreshUsage: async () => { },
		onUsageChange: listener => { listeners.push(listener); return { dispose() { } }; },
	};
	const read = (next: UsageState) => {
		usage = next;
		listeners.forEach(listener => listener('a'));
	};
	return { control, read };
}

describe('ControlPage', () => {
	it('drops the sign-in complaint once a usage read proves the account', async () => {
		const { control, read } = fake(async () => ({ ok: false, message: 'Run this in a terminal.' }));
		const page = new ControlPage(control, { openExternal: async () => { }, copyToClipboard: async () => { } });

		await page.handle({ type: 'signIn', agentId: 'a' });
		expect((await page.state()).agents[0].error).toBe('Run this in a terminal.');

		read({ status: 'ok', extraWindows: [], signedIn: true });
		expect((await page.state()).agents[0].error).toBeUndefined();
	});

	it('keeps the complaint while a read proves nothing', async () => {
		const { control, read } = fake(async () => ({ ok: false, message: 'Run this in a terminal.' }));
		const page = new ControlPage(control, { openExternal: async () => { }, copyToClipboard: async () => { } });

		await page.handle({ type: 'signIn', agentId: 'a' });
		read({ status: 'unavailable', extraWindows: [] });
		expect((await page.state()).agents[0].error).toBe('Run this in a terminal.');
	});
});
