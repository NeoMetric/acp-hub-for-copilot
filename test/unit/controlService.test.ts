import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, InstallContext } from '../../src/core/adapter';
import { UsageStore } from '../../src/engine/chat/usage';
import { ControlService, type ControlHost, type ControlServiceOptions, type SettingValue } from '../../src/engine/control/ControlService';
import type { ConfigReader, SecretStore, StateStore } from '../../src/engine/ports/state';

class MemoryState implements StateStore {
	readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
	}
}

class MemorySecrets implements SecretStore {
	readonly values = new Map<string, string>();

	async get(id: string): Promise<string | undefined> {
		return this.values.get(id);
	}

	async set(id: string, value: string): Promise<void> {
		this.values.set(id, value);
	}

	async delete(id: string): Promise<void> {
		this.values.delete(id);
	}
}

class MemoryConfig implements ConfigReader {
	constructor(readonly values = new Map<string, unknown>()) { }

	get<T>(section: string): T | undefined {
		return this.values.get(section) as T | undefined;
	}
}

function adapter(id: string, extra: Partial<AgentAdapter> = {}): AgentAdapter {
	return {
		id,
		displayName: `Agent ${id}`,
		vendor: `acphub-${id}`,
		install: { kind: 'download', version: '1', find: async () => undefined, install: async () => '' },
		launch: () => ({ command: id, args: [], env: {} }),
		auth: [],
		settings: [{ key: 'level', type: 'enum', label: 'Level', description: '', default: 'low', options: ['low', 'high'] }],
		modelPolicy: {} as AgentAdapter['modelPolicy'],
		systemPrompt: { toolAccess: '', listRequiredArguments: false },
		...extra,
	};
}

/** An agent the fake install puts on the machine, so its install state can change. */
function installable(id: string): AgentAdapter {
	let installed = false;
	const entry = `C:/agents/${id}/agent.exe`;
	return adapter(id, {
		install: {
			kind: 'download',
			version: '1',
			find: async () => installed ? entry : undefined,
			install: async (ctx: InstallContext) => {
				ctx.progress('Downloading', 0.5);
				installed = true;
				return entry;
			},
		},
	});
}

function hostCallbacks(overrides: Partial<ControlHost> = {}): ControlHost {
	return {
		signIn: vi.fn(async () => ({ ok: true })),
		showOutput: vi.fn(),
		launchOf: async () => ({ entryPath: 'agent', installDir: '', storageDir: '', settings: {}, workspaceFolder: '' }),
		confirmUninstall: vi.fn(async () => true),
		closeSessions: vi.fn(async () => { }),
		restartAgent: vi.fn(async () => { }),
		refreshAgent: vi.fn(),
		publishModels: vi.fn(async () => { }),
		prepareAgent: async () => true,
		askAgent: async () => undefined,
		...overrides,
	};
}

function setup(overrides: Partial<ControlServiceOptions> = {}) {
	const state = new MemoryState();
	const secrets = new MemorySecrets();
	const config = new MemoryConfig();
	const written: Array<{ key: string; value: SettingValue }> = [];
	const host = hostCallbacks();
	const options: ControlServiceOptions = {
		adapters: [installable('a'), adapter('b')],
		state,
		secrets,
		settings: config,
		usage: new UsageStore(() => { }),
		install: {
			storageDir: 'test/unit/agents-that-never-were',
			extensionDir: 'test/unit',
			log: () => { },
			progress: () => { },
		},
		writeConfig: async (key, value) => { written.push({ key, value }); },
		host,
		...overrides,
	};
	return { service: new ControlService(options), state, secrets, config, written, options, host: options.host };
}

describe('ControlService', () => {
	it('lists the agents it drives', () => {
		const { service } = setup();
		expect(service.agents().map(item => item.id)).toEqual(['a', 'b']);
	});

	it('reports and changes the install state, forwarding the install progress', async () => {
		const { service, host } = setup();
		expect(await service.installState('a')).toBe('not-installed');

		const progress: Array<{ message: string; fraction?: number }> = [];
		await service.install('a', (message, fraction) => { progress.push({ message, fraction }); });

		expect(progress).toEqual([{ message: 'Downloading', fraction: 0.5 }, { message: 'Starting the agent...', fraction: undefined }]);
		expect(await service.installState('a')).toBe('installed');
		expect(host.refreshAgent).toHaveBeenCalledWith('a');
		expect(host.publishModels).toHaveBeenCalledWith('a');
	});

	it('asks before uninstalling, stops the agent and reloads it', async () => {
		const { service, host } = setup();
		await service.install('a', () => { });
		expect(await service.uninstall('a')).toBe(true);
		expect(host.confirmUninstall).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
		expect(host.closeSessions).toHaveBeenCalledWith('a');
		expect(host.restartAgent).toHaveBeenCalledWith('a');
		expect(host.refreshAgent).toHaveBeenLastCalledWith('a');
		expect(host.publishModels).toHaveBeenCalledWith('a');
	});

	it('leaves the agent alone when the user declines the uninstall', async () => {
		const { service, host } = setup({ host: hostCallbacks({ confirmUninstall: async () => false }) });
		await service.install('a', () => { });
		expect(await service.uninstall('a')).toBe(false);
		expect(host.closeSessions).not.toHaveBeenCalled();
		expect(await service.installState('a')).toBe('installed');
	});

	it('signs in through the host and clears the saved key on sign-out', async () => {
		const { service, secrets, host } = setup();
		expect(await service.signIn('a')).toEqual({ ok: true });
		expect(host.signIn).toHaveBeenCalledWith('a');

		await secrets.set('a', 'key-1');
		await service.signOut('a');
		expect(await secrets.get('a')).toBeUndefined();
		expect(host.restartAgent).toHaveBeenCalledWith('a');
		expect(host.refreshAgent).toHaveBeenCalledWith('a');
	});

	it('reads the saved key as signed in, then the state the usage read wrote', async () => {
		const { service, state, secrets } = setup();
		expect(await service.isSignedIn('a')).toBeUndefined();
		expect(await service.hasSavedKey('a')).toBe(false);

		await state.update('signedIn.a', true);
		expect(await service.isSignedIn('a')).toBe(true);

		await secrets.set('a', 'key-1');
		await state.update('signedIn.a', false);
		expect(await service.isSignedIn('a')).toBe(true);
		expect(await service.hasSavedKey('a')).toBe(true);
	});

	it('reads the settings of an agent, with the adapter defaults', () => {
		const { service, config } = setup();
		expect(service.readSettings('a')).toEqual({ level: 'low' });
		config.values.set('agents.a.level', 'high');
		expect(service.readSettings('a')).toEqual({ level: 'high' });
	});

	it('writes a setting through to the config writer under the agent\'s key', async () => {
		const { service, written } = setup();
		await service.writeSetting('a', 'level', 'high');
		expect(written).toEqual([{ key: 'agents.a.level', value: 'high' }]);
	});

	it('reads and writes the settings that apply to every agent', async () => {
		const { service, config, written } = setup();
		expect(service.readGlobalSetting('resume.transcriptDetail')).toBeUndefined();
		config.values.set('resume.transcriptDetail', 'full');
		expect(service.readGlobalSetting('resume.transcriptDetail')).toBe('full');

		await service.writeGlobalSetting('resume.transcriptDetail', 'compact');
		expect(written).toEqual([{ key: 'resume.transcriptDetail', value: 'compact' }]);
	});

	it('enables an agent unless its setting says otherwise, and writes a change', async () => {
		const { service, config, written, host } = setup();
		expect(service.isEnabled('a')).toBe(true);

		config.values.set('agents.a.enabled', false);
		expect(service.isEnabled('a')).toBe(false);

		await service.setEnabled('a', true);
		expect(written).toEqual([{ key: 'agents.a.enabled', value: true }]);
		expect(host.refreshAgent).toHaveBeenCalledWith('a');
	});

	it('reports usage as unsupported for an agent that has no usage source, and reads one that has', async () => {
		const { service } = setup();
		expect(service.usage('b')).toEqual({ status: 'unsupported', extraWindows: [] });

		const read = vi.fn(async () => ({ plan: 'Pro', windows: [{ label: '5h', usedPercent: 12 }] }));
		const withUsage = adapter('u', { usage: { read } });
		const reading = setup({ adapters: [withUsage] });
		await reading.service.refreshUsage('u');

		expect(read).toHaveBeenCalledTimes(1);
		expect(reading.service.usage('u').status).toBe('ok');
		expect(reading.service.usage('u').reading?.windows).toEqual([{ label: '5h', usedPercent: 12 }]);
	});

	it('starts the agent before reading its usage, and skips a read it cannot launch', async () => {
		const prepareAgent = vi.fn(async () => true);
		const askAgent = vi.fn(async () => 'reply');
		const withUsage = adapter('u', { usage: { read: async ctx => ({ windows: [{ label: '5h', usedPercent: await ctx.askAgent('limits') === 'reply' ? 10 : 0 }] }) } });
		const { service } = setup({ adapters: [withUsage], host: hostCallbacks({ prepareAgent, askAgent }) });

		await service.refreshUsage('u');
		expect(prepareAgent).toHaveBeenCalledWith('u');
		expect(askAgent).toHaveBeenCalledWith('u', 'limits');
		expect(service.usage('u').reading).toEqual({ windows: [{ label: '5h', usedPercent: 10 }] });

		const uninstalled = setup({ adapters: [withUsage], host: hostCallbacks({ launchOf: async () => undefined }) });
		await uninstalled.service.refreshUsage('u');
		expect(uninstalled.service.usage('u').status).toBe('idle');
	});

	it('saves the visible agents in the shared store', async () => {
		const { service, state } = setup();
		expect(service.visibleAgents()).toBeUndefined();
		await service.saveVisibleAgents(['a']);
		expect(service.visibleAgents()).toEqual(['a']);
		expect(state.keys()).toContain('sidebar.visibleAgents');
	});

	it('tells a listener when the usage of an agent changes', async () => {
		const withUsage = adapter('u', { usage: { read: async () => ({ windows: [{ label: '5h', usedPercent: 1 }] }) } });
		const { service } = setup({ adapters: [withUsage] });
		const seen: string[] = [];
		const listener = service.onUsageChange(id => { seen.push(id); });
		await service.refreshUsage('u');
		expect(seen).toEqual(['u', 'u']);
		listener.dispose();
		await service.refreshUsage('u');
		expect(seen).toEqual(['u', 'u']);
	});

	it('refuses an agent it does not drive', async () => {
		const { service } = setup();
		await expect(service.installState('nope')).rejects.toThrow('Unknown agent: nope');
	});
});
