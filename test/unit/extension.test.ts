import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import { REGISTRY } from '../../src/core/registry';
import { agentsRoot } from '../../src/engine/store/paths';

/** What the window handed the link to the server, as the test reads it back. */
interface LinkDeps {
	root: string;
	port: number;
	autoStart: boolean;
	serverScript: string;
	extensionDir: string;
	promptsDir?: string;
	log: (message: string, level?: string) => void;
}

/** What a provider was built with. */
interface ProviderDeps {
	agentId: string;
	vendor: string;
	link: unknown;
	state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> };
	log: (message: string, level?: string) => void;
	windowFolder(): string;
}

/** What the sidebar's relay was built with. */
interface RelayDeps {
	link: unknown;
	openExternal(url: string): Promise<void>;
	copyToClipboard(text: string): Promise<void>;
	confirmUninstall(displayName: string): Promise<boolean>;
	log: (message: string, level?: string) => void;
}

const mocks = vi.hoisted(() => ({
	/** The settings the window reports, as `getConfiguration('acpHub')` answers them. */
	config: {} as Record<string, unknown>,
	/** The folders the window has open, as `workspace.workspaceFolders` answers them. */
	folders: undefined as undefined | Array<{ uri: { fsPath: string } }>,
	/** The vendor of every provider the window registered, in registration order. */
	registered: [] as Array<{ vendor: string; provider: unknown }>,
	/** The dependencies each provider was built with, in registry order. */
	providers: [] as ProviderDeps[],
	/** The agents whose models the window asked the workbench to list again, in order. */
	refreshed: [] as string[],
	published: 0,
	/** The dependencies the link was built with, and the listeners it was given. */
	linkDeps: [] as LinkDeps[],
	linkListeners: new Set<(state: unknown) => void>(),
	ensured: 0,
	disposed: 0,
	/** The relay, and the dependencies it was built with. */
	relays: [] as unknown[],
	relayDeps: [] as RelayDeps[],
	relayListeners: new Set<(state: unknown) => void>(),
	actions: [] as Array<Record<string, unknown>>,
	/** The sidebar view and the host it was registered with. */
	views: [] as Array<{ id: string; provider: unknown }>,
	hosts: [] as Array<{ transport: unknown; deps: { assetUri(relative: string): { path: string } } }>,
	commands: new Map<string, (...args: unknown[]) => unknown>(),
	logged: [] as Array<{ message: string; level: string }>,
	shown: 0,
	executed: [] as string[],
	opened: [] as string[],
	copied: [] as string[],
	warnings: [] as unknown[][],
	quickPicks: [] as Array<Array<{ label: string; id: string }>>,
	/** Which entry the quick pick returns; `undefined` cancels it. */
	pick: undefined as number | undefined,
	/** What the API key migration was given, once per activation that ran it. */
	keyMigrations: [] as Array<{
		secrets: unknown;
		target: unknown;
		agentIds: string[];
		state: unknown;
		log: (message: string, level?: string) => void;
	}>,
}));

vi.mock('vscode', () => {
	const disposable = () => ({ dispose() { } });
	return {
		lm: {
			registerLanguageModelChatProvider: (vendor: string, provider: unknown) => {
				mocks.registered.push({ vendor, provider });
				return disposable();
			},
			selectChatModels: async () => [],
		},
		window: {
			createOutputChannel: () => ({
				info: (message: string) => { mocks.logged.push({ message, level: 'info' }); },
				warn: (message: string) => { mocks.logged.push({ message, level: 'warn' }); },
				error: (message: string) => { mocks.logged.push({ message, level: 'error' }); },
				debug: (message: string) => { mocks.logged.push({ message, level: 'debug' }); },
				show: () => { mocks.shown += 1; },
				dispose() { },
			}),
			registerWebviewViewProvider: (id: string, provider: unknown) => {
				mocks.views.push({ id, provider });
				return disposable();
			},
			showQuickPick: async (items: Array<{ label: string; id: string }>) => {
				mocks.quickPicks.push(items);
				return mocks.pick === undefined ? undefined : items[mocks.pick];
			},
			showWarningMessage: async (...args: unknown[]) => {
				mocks.warnings.push(args);
				return 'Uninstall';
			},
		},
		commands: {
			registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
				mocks.commands.set(id, handler);
				return disposable();
			},
			executeCommand: async (id: string) => {
				mocks.executed.push(id);
			},
		},
		workspace: {
			get workspaceFolders() { return mocks.folders; },
			getConfiguration: () => ({ get: <T>(key: string, fallback?: T) => (key in mocks.config ? mocks.config[key] as T : fallback) }),
		},
		env: {
			openExternal: async (uri: { path: string }) => {
				mocks.opened.push(uri.path);
				return true;
			},
			clipboard: {
				writeText: async (text: string) => { mocks.copied.push(text); },
			},
		},
		Uri: {
			parse: (value: string) => ({ path: value }),
			joinPath: (base: { fsPath: string }, ...rest: string[]) => ({ path: path.join(base.fsPath, ...rest) }),
		},
	};
});
vi.mock('../../src/hosts/vscode/serverLink', () => ({
	ServerLink: class {
		constructor(deps: LinkDeps) { mocks.linkDeps.push(deps); }
		get state() { return undefined; }
		ensure() {
			mocks.ensured += 1;
			return Promise.resolve({ kind: 'ready', endpoint: { baseUrl: 'http://127.0.0.1:8791' }, owned: true });
		}
		onDidChange(listener: (state: unknown) => void) {
			mocks.linkListeners.add(listener);
			return () => { mocks.linkListeners.delete(listener); };
		}
		dispose() {
			mocks.disposed += 1;
			return Promise.resolve();
		}
	},
}));
vi.mock('../../src/hosts/vscode/serverProvider', () => ({
	ServerProvider: class {
		constructor(private readonly deps: ProviderDeps) { mocks.providers.push(deps); }
		publishModels() {
			mocks.published += 1;
			return Promise.resolve();
		}
		refresh() { mocks.refreshed.push(this.deps.agentId); }
		dispose() { }
	},
}));
vi.mock('../../src/sidebar/relay', () => ({
	SidebarRelay: class {
		constructor(deps: RelayDeps) {
			mocks.relayDeps.push(deps);
			mocks.relays.push(this);
		}
		send(action: Record<string, unknown>) { mocks.actions.push(action); }
		onState(listener: (state: unknown) => void) {
			mocks.relayListeners.add(listener);
			return () => { mocks.relayListeners.delete(listener); };
		}
		dispose() { }
	},
}));
vi.mock('../../src/core/secretsMigration', () => ({
	migrateSecretsOnce: (deps: (typeof mocks.keyMigrations)[number]) => {
		mocks.keyMigrations.push(deps);
		return Promise.resolve(true);
	},
}));
vi.mock('../../src/sidebar/host', () => ({
	SidebarHost: class {
		constructor(readonly transport: unknown, readonly deps: { assetUri(relative: string): { path: string } }) {
			mocks.hosts.push({ transport, deps });
		}
	},
}));

import { activate, deactivate } from '../../src/extension';

/** A store root of its own for one test, so nothing touches the user's home folder. */
const storeRoots: string[] = [];
/** The extension's own folder for one test. */
let extensionDir = '';
/** The extension's global storage folder for the same test. */
let globalStorage = '';
/** The store root activation settles on, for the same test. */
let root = '';
/** The secret storage the window hands `activate`, for the same test. */
let contextSecrets: unknown = undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-extension-'));
	storeRoots.push(root);
	globalStorage = path.join(root, 'global-storage');
	extensionDir = path.join(root, 'extension');
	process.env.ACP_HUB_HOME = root;
	mocks.folders = undefined;
	mocks.registered.length = 0;
	mocks.providers.length = 0;
	mocks.refreshed.length = 0;
	mocks.published = 0;
	mocks.linkDeps.length = 0;
	mocks.linkListeners.clear();
	mocks.ensured = 0;
	mocks.disposed = 0;
	mocks.relays.length = 0;
	mocks.relayDeps.length = 0;
	mocks.relayListeners.clear();
	mocks.actions.length = 0;
	mocks.views.length = 0;
	mocks.hosts.length = 0;
	mocks.commands.clear();
	mocks.logged.length = 0;
	mocks.shown = 0;
	mocks.executed.length = 0;
	mocks.opened.length = 0;
	mocks.copied.length = 0;
	mocks.warnings.length = 0;
	mocks.quickPicks.length = 0;
	mocks.pick = undefined;
	mocks.keyMigrations.length = 0;
	contextSecrets = { get: async () => undefined, store: async () => undefined, delete: async () => undefined };
	for (const key of Object.keys(mocks.config)) {
		delete mocks.config[key];
	}
});

afterEach(async () => {
	delete process.env.ACP_HUB_HOME;
	// The store writes in the background; let those writes land before the folder goes.
	await new Promise(resolve => setTimeout(resolve, 50));
	for (const directory of storeRoots.splice(0)) {
		try {
			fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		} catch { /* A leftover temp folder is not the test's business. */ }
	}
});

function contextOf() {
	return {
		subscriptions: [] as Array<{ dispose(): unknown }>,
		globalStorageUri: { fsPath: globalStorage },
		extensionUri: { fsPath: extensionDir },
		extension: { packageJSON: { version: '1' } },
		globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
		secrets: contextSecrets,
	} as never;
}

function activateOnce(): void {
	activate(contextOf());
}

function source(): string {
	return fs.readFileSync('src/extension.ts', 'utf8');
}

describe('the extension is a client of the server', () => {
	it('registers one provider per agent, under the vendor names of main', () => {
		activateOnce();

		expect(mocks.registered.map(entry => entry.vendor)).toEqual(['Claude Agent', 'Codex Agent', 'Google Agent']);
		expect(mocks.registered.map(entry => entry.vendor)).toEqual(packageJson.contributes.languageModelChatProviders.map(contribution => contribution.vendor));
		expect(mocks.providers.map(deps => deps.agentId)).toEqual(REGISTRY.agents.map(agent => agent.id));
		expect(mocks.providers.map(deps => deps.vendor)).toEqual(mocks.registered.map(entry => entry.vendor));
		// The Agents window lists nothing a provider does not republish.
		expect(mocks.published).toBe(3);
	});

	it('does not build an in-host ChatService', () => {
		const text = source();
		expect(text).not.toMatch(/engine\/chat/);
		expect(text).not.toMatch(/core\/provider/);
		// Adapter code is the server's: the extension reads the registry, never the adapters.
		expect(text).not.toMatch(/core\/agents/);
		expect(text).toMatch(/hosts\/vscode\/serverLink/);
		expect(text).toMatch(/sidebar\/relay/);
	});

	it('starts or attaches to the server the settings name', () => {
		activateOnce();

		const deps = mocks.linkDeps[0];
		expect(deps.root).toBe(root);
		expect(deps.port).toBe(8791);
		expect(deps.autoStart).toBe(true);
		expect(deps.serverScript).toBe(path.join(extensionDir, 'dist', 'server.js'));
		expect(deps.extensionDir).toBe(extensionDir);
		expect(deps.promptsDir).toBe(path.join(path.dirname(path.dirname(globalStorage)), 'prompts'));
		// A server is reached, or started, as soon as the window loads.
		expect(mocks.ensured).toBeGreaterThan(0);
	});

	it('reads the port and the auto-start switch from its own settings', () => {
		mocks.config['server.port'] = 9123;
		mocks.config['server.autoStart'] = false;
		activateOnce();

		expect(mocks.linkDeps[0].port).toBe(9123);
		expect(mocks.linkDeps[0].autoStart).toBe(false);
	});

	it('writes the reason a server cannot be used to the output channel', () => {
		activateOnce();
		const reason = `The ACP Hub server on port 8791 rejected the token; check ${path.join(root, 'server.token')}.`;

		for (const listener of mocks.linkListeners) {
			listener({ kind: 'unavailable', reason });
		}

		const line = mocks.logged.find(entry => entry.message.includes(reason));
		expect(line).toBeDefined();
		expect(line?.level).toBe('warn');
	});

	it('gives each provider the window folder, or the agents folder when the window has none', () => {
		activateOnce();
		expect(mocks.providers[0].windowFolder()).toBe(agentsRoot(root));

		const folder = path.join(root, 'my repo');
		mocks.folders = [{ uri: { fsPath: folder } }];
		expect(mocks.providers[0].windowFolder()).toBe(folder);
	});

	it('registers the sidebar view over the relay', () => {
		activateOnce();

		expect(mocks.views.map(view => view.id)).toEqual(['acpHub.agents']);
		const host = mocks.hosts[0];
		expect(mocks.views[0].provider).toBeDefined();
		expect(host.transport).toBe(mocks.relays[0]);
		expect(host.deps.assetUri('dist/sidebar.js').path).toBe(path.join(extensionDir, 'dist', 'sidebar.js'));
	});

	it('hands the sidebar the window parts its relay needs', async () => {
		activateOnce();
		const relay = mocks.relayDeps[0];

		await relay.openExternal('https://example.test/device');
		await relay.copyToClipboard('ABC-123');

		expect(mocks.opened).toEqual(['https://example.test/device']);
		expect(mocks.copied).toEqual(['ABC-123']);
		expect(relay.link).toBeDefined();
	});

	it('confirms an uninstall in a modal dialog before the server is asked', async () => {
		activateOnce();

		const confirmed = await mocks.relayDeps[0].confirmUninstall('Claude Agent');

		expect(confirmed).toBe(true);
		expect(mocks.warnings[0][0]).toBe('Uninstall Claude Agent?');
		expect(mocks.warnings[0][1]).toMatchObject({ modal: true });
		expect(String((mocks.warnings[0][1] as { detail?: string }).detail)).toContain('Your sign-in, saved API key and settings are kept.');
		expect(mocks.warnings[0][2]).toBe('Uninstall');
	});

	it('registers the commands the manifest contributes, and runs them through the relay', async () => {
		mocks.pick = 1;
		activateOnce();

		expect([...mocks.commands.keys()].sort()).toEqual(['acpHub.install', 'acpHub.refreshUsage', 'acpHub.showLogs', 'acpHub.signIn']);

		mocks.commands.get('acpHub.showLogs')?.();
		expect(mocks.shown).toBe(1);

		await mocks.commands.get('acpHub.signIn')?.();
		expect(mocks.quickPicks[0].map(item => item.label)).toEqual(['Claude Agent', 'Codex Agent', 'Google Agent']);
		expect(mocks.actions).toContainEqual({ type: 'signIn', agentId: 'codex' });

		await mocks.commands.get('acpHub.install')?.();
		expect(mocks.executed).toEqual(['acpHub.agents.focus']);

		await mocks.commands.get('acpHub.refreshUsage')?.();
		expect(mocks.actions.filter(action => action.type === 'refreshUsage').map(action => action.agentId)).toEqual(['claude', 'codex', 'google']);
	});

	it('drops a cancelled sign-in, and nothing else', async () => {
		activateOnce();

		await mocks.commands.get('acpHub.signIn')?.();

		expect(mocks.actions).toEqual([]);
	});

	it('deactivate stops the server this window owns', async () => {
		activateOnce();

		await deactivate();

		expect(mocks.disposed).toBe(1);
	});

	it('asks the provider of an agent whose card changed to list its models again', () => {
		activateOnce();
		const card = (overrides: Record<string, unknown> = {}) => ({
			id: 'claude',
			displayName: 'Claude Agent',
			install: 'installed',
			removable: true,
			signedIn: 'yes',
			hasSavedKey: false,
			enabled: true,
			visible: true,
			settings: [],
			usage: { status: 'idle', windows: [] },
			...overrides,
		});
		const draw = (...agents: unknown[]): void => {
			for (const listener of mocks.relayListeners) {
				listener({ agents });
			}
		};

		// The first snapshot is the first news of every card it holds.
		draw(card(), card({ id: 'codex' }), card({ id: 'google' }));
		expect(mocks.refreshed).toEqual(['claude', 'codex', 'google']);

		mocks.refreshed.length = 0;
		draw(card(), card({ id: 'codex' }), card({ id: 'google' }));
		expect(mocks.refreshed, 'an unchanged snapshot asks for nothing').toEqual([]);

		draw(card(), card({ id: 'codex', install: 'not-installed' }), card({ id: 'google', enabled: false }));
		expect(mocks.refreshed, 'the agents whose card changed are the ones listed again').toEqual(['codex', 'google']);

		mocks.refreshed.length = 0;
		draw(card(), card({ id: 'codex', install: 'not-installed' }), card({ id: 'google', enabled: false, busy: 'Signing in...' }));
		expect(mocks.refreshed, 'a busy line alone changes no model').toEqual([]);
	});
});

describe('the upgrade paths the extension still owns', () => {
	it('moves an agent the previous version installed in global storage into the shared root', () => {
		const legacy = path.join(globalStorage, 'claude');
		fs.mkdirSync(legacy, { recursive: true });
		fs.writeFileSync(path.join(legacy, 'entry.js'), 'claude');

		activateOnce();

		// The move runs before activation returns, so the server's first install check already finds the agent.
		expect(fs.readFileSync(path.join(root, 'agents', 'claude', 'entry.js'), 'utf8')).toBe('claude');
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it('carries the API keys of every registry agent over from the window secret storage', () => {
		activateOnce();

		expect(mocks.keyMigrations).toHaveLength(1);
		const deps = mocks.keyMigrations[0];
		expect(deps.agentIds).toEqual(REGISTRY.agents.map(agent => agent.id));
		expect(deps.secrets).toBe(contextSecrets);
		// The keys land in the store the server reads, under the state that records the one pass.
		expect(deps.target).toBeDefined();
		expect(deps.state).toBeDefined();
	});
});
