import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolBridge } from '../../src/engine/chat/types';

/** What a host hands its agent service, narrowed to the part this test reads. */
interface ServiceDeps {
	resolveLaunch(): Promise<{ storageDir: string } | undefined>;
}

const mocks = vi.hoisted(() => ({
	installed: false,
	/** The extension's providers, with the dependencies they were built with. */
	providers: [] as Array<{ adapter: { id: string }; deps: ServiceDeps & { client: { storageDir: string } } }>,
	/** The headless composition's services, by the agent they drive. */
	services: new Map<string, ServiceDeps>(),
	killed: [] as string[],
}));

vi.mock('vscode', () => {
	const disposable = () => ({ dispose() { } });
	return {
		lm: { registerLanguageModelChatProvider: disposable },
		window: {
			createOutputChannel: () => ({ info() { }, warn() { }, error() { }, debug() { }, show() { }, dispose() { } }),
			registerWebviewViewProvider: disposable,
			onDidChangeWindowState: disposable,
			withProgress: async <T>(_options: unknown, task: () => Promise<T>) => task(),
		},
		commands: { registerCommand: disposable },
		workspace: {
			workspaceFolders: undefined,
			getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback, update: async () => undefined }),
			onDidChangeConfiguration: disposable,
		},
		Uri: { joinPath: (...parts: unknown[]) => parts[0] },
	};
});
vi.mock('../../src/core/provider', () => ({
	AcpProvider: class {
		constructor(readonly adapter: { id: string }, readonly deps: ServiceDeps & { client: { storageDir: string } }) { mocks.providers.push(this); }
		onDidRequireSignIn() { return { dispose() { } }; }
		onDidMeasureRequest() { return { dispose() { } }; }
		onDidFinishTurn() { return { dispose() { } }; }
		publishModels() { return Promise.resolve(); }
		restart() { return Promise.resolve(); }
		invalidateLaunch() { }
		refresh() { }
		closeAllSessions() { return Promise.resolve(); }
		prepareAgent() { return Promise.resolve(true); }
		askAgent() { return Promise.resolve(undefined); }
		startForSignIn() { return Promise.resolve(false); }
		wakeAfterIdle() { }
		dispose() { }
	},
}));
vi.mock('../../src/engine/chat/ChatService', () => ({
	ChatService: class {
		constructor(deps: ServiceDeps & { adapter: { id: string } }) { mocks.services.set(deps.adapter.id, deps); }
		close() { return Promise.resolve(); }
		closeAllSessions() { return Promise.resolve(); }
		restart() { return Promise.resolve(); }
		invalidateLaunch() { }
		client() { return Promise.reject(new Error('the test starts no agent')); }
		askAgent() { return Promise.resolve(undefined); }
	},
}));
// A usage read would start an agent; the test only asks where the agents would be installed.
vi.mock('../../src/engine/chat/usage', () => ({
	UsageStore: class {
		get() { return { status: 'idle', extraWindows: [] }; }
		refresh() { return Promise.resolve(); }
		recordRequest() { }
		recordTurn() { }
		onDidChange() { return { dispose() { } }; }
	},
}));
vi.mock('../../src/core/bridge', () => ({
	McpBridge: class { dispose() { } },
}));
vi.mock('../../src/core/secrets', () => ({
	AgentSecretStore: class { get() { return Promise.resolve(undefined); } onDidChange() { return { dispose() { } }; } dispose() { } },
}));
vi.mock('../../src/sidebar/host', () => ({
	SidebarHost: class { refresh() { } showSignInUrl() { } },
}));
vi.mock('../../src/core/processes', () => ({
	killAllChildren: () => undefined,
	killStrayAgents: (dir: string) => { mocks.killed.push(dir); return []; },
}));
vi.mock('../../src/core/installers', () => ({
	findInstalled: async () => mocks.installed ? { entryPath: 'agent', installDir: 'install' } : undefined,
	getInstallState: async () => 'installed',
	installAgent: async () => undefined,
	uninstallAgent: async () => undefined,
	needsUpdate: async () => false,
}));
// The Google adapter reads its CLI's data folder when the registry is loaded.
vi.mock('../../src/adapters/googleHub', () => ({
	APP_DATA_DIR: 'antigravity-copilot',
	startHub: async () => ({ port: 1, token: 't', stop: async () => undefined }),
	callHub: async () => ({ response: {} }),
}));

import { createHeadlessComposition } from '../../src/composition/headless';
import { activate } from '../../src/extension';

const NO_LOG = (): void => undefined;

/** A bridge that hands out an endpoint and runs nothing; the test starts no agent. */
const noTools: ToolBridge = {
	registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
	updateTools: () => undefined,
	unregisterSession: () => undefined,
};

const roots: string[] = [];
let root: string;
let extensionDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-root-'));
	roots.push(root);
	process.env.ACP_HUB_HOME = root;
	extensionDir = path.join(root, 'extension');
	fs.mkdirSync(extensionDir);
	mocks.installed = false;
	mocks.providers.length = 0;
	mocks.services.clear();
	mocks.killed.length = 0;
});

afterEach(async () => {
	delete process.env.ACP_HUB_HOME;
	// The store writes in the background; let those writes land before the folder goes.
	await new Promise(resolve => setTimeout(resolve, 50));
	for (const dir of roots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

describe('the agent storage root', () => {
	it('installs an agent at <root>/agents/<id> in the extension and in the headless composition alike', async () => {
		activate({
			subscriptions: [],
			globalStorageUri: { fsPath: path.join(root, 'vscode-storage') },
			extensionUri: { fsPath: extensionDir },
			extension: { packageJSON: { version: '1' } },
			globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
			secrets: {},
		} as never);

		mocks.installed = true;
		const expected = (id: string): string => path.join(root, 'agents', id);
		expect(mocks.providers.length).toBeGreaterThan(0);
		for (const provider of mocks.providers) {
			const id = provider.adapter.id;
			expect(provider.deps.client.storageDir, id).toBe(expected(id));
			expect((await provider.deps.resolveLaunch())?.storageDir, id).toBe(expected(id));
			// The pid registry of the agent sits in the same folder both gateways read.
			expect(mocks.killed, id).toContain(path.join(expected(id), 'agents'));
		}

		const composition = createHeadlessComposition({ root, bridge: noTools, log: NO_LOG, extensionDir });
		for (const adapter of composition.adapters) {
			const service = mocks.services.get(adapter.id);
			expect(service, adapter.id).toBeDefined();
			expect((await service!.resolveLaunch())?.storageDir, adapter.id).toBe(expected(adapter.id));
		}
		await composition.close();

		// The uninstall hook is told about the shared root, not the extension's private folder.
		expect(JSON.parse(fs.readFileSync(path.join(extensionDir, 'storage-paths.json'), 'utf8'))).toEqual([path.join(root, 'agents')]);
	});
});
