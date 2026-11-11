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
	/** The store roots the extension's link to the server was built with. */
	linkRoots: [] as string[],
	/** The window folder each of the extension's providers fell back to. */
	windowFolders: [] as Array<() => string>,
	/** The headless composition's services, by the agent they drive. */
	services: new Map<string, ServiceDeps>(),
}));

vi.mock('vscode', () => {
	const disposable = () => ({ dispose() { } });
	return {
		lm: { registerLanguageModelChatProvider: disposable, selectChatModels: async () => [] },
		window: {
			createOutputChannel: () => ({ info() { }, warn() { }, error() { }, debug() { }, show() { }, dispose() { } }),
			registerWebviewViewProvider: disposable,
			showQuickPick: async () => undefined,
			showWarningMessage: async () => undefined,
		},
		commands: { registerCommand: disposable, executeCommand: async () => undefined },
		workspace: {
			workspaceFolders: undefined,
			getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback }),
		},
		env: { openExternal: async () => true, clipboard: { writeText: async () => undefined } },
		Uri: { joinPath: (...parts: unknown[]) => parts[0], parse: (value: string) => ({ path: value }) },
	};
});
vi.mock('../../src/hosts/vscode/serverLink', () => ({
	ServerLink: class {
		constructor(deps: { root: string }) { mocks.linkRoots.push(deps.root); }
		ensure() { return Promise.resolve({ kind: 'unavailable', reason: 'the test starts no server' }); }
		onDidChange() { return () => undefined; }
		dispose() { return Promise.resolve(); }
	},
}));
vi.mock('../../src/hosts/vscode/serverProvider', () => ({
	ServerProvider: class {
		constructor(deps: { windowFolder(): string }) { mocks.windowFolders.push(deps.windowFolder); }
		publishModels() { return Promise.resolve(); }
		dispose() { }
	},
}));
vi.mock('../../src/sidebar/relay', () => ({
	SidebarRelay: class {
		send() { }
		onState() { return () => undefined; }
		dispose() { }
	},
}));
vi.mock('../../src/sidebar/host', () => ({
	SidebarHost: class { constructor(..._args: unknown[]) { } },
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
vi.mock('../../src/engine/mcp/bridge', () => ({
	McpBridge: class { dispose() { } },
}));
// The Google adapter reads its CLI's data folder when the registry is loaded.
vi.mock('../../src/adapters/googleHub', () => ({
	APP_DATA_DIR: 'antigravity-copilot',
	startHub: async () => ({ port: 1, token: 't', stop: async () => undefined }),
	callHub: async () => ({ response: {} }),
}));
vi.mock('../../src/core/installers', () => ({
	findInstalled: async () => mocks.installed ? { entryPath: 'agent', installDir: 'install' } : undefined,
	getInstallState: async () => 'installed',
	installAgent: async () => undefined,
	uninstallAgent: async () => undefined,
	needsUpdate: async () => false,
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
	mocks.linkRoots.length = 0;
	mocks.windowFolders.length = 0;
	mocks.services.clear();
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
		} as never);

		const expected = (id: string): string => path.join(root, 'agents', id);
		// The window shares one store with the server, and roots a chat in the agents folder when it has no folder of its own.
		expect(mocks.linkRoots).toEqual([root]);
		expect(mocks.windowFolders.length).toBeGreaterThan(0);
		for (const windowFolder of mocks.windowFolders) {
			expect(windowFolder()).toBe(path.join(root, 'agents'));
		}

		mocks.installed = true;
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
