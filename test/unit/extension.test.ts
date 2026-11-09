import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';

const mocks = vi.hoisted(() => ({
  register: vi.fn((_vendor: string, _provider: unknown) => ({ dispose() {} })),
  registerView: vi.fn(() => ({ dispose() {} })),
  registerCommand: vi.fn(() => ({ dispose() {} })),
  output: { info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {} },
  enabled: true,
  disabledIds: new Set<string>(),
  installedIds: new Set<string>(),
  sidebarControl: [] as Array<{ usage: (id: string) => { status: string; reading?: { windows: Array<{ usedPercent: number }> } } }>,
  providerDeps: [] as Array<{ isEnabled: () => boolean }>,
  configurationChanged: undefined as ((event: { affectsConfiguration: (key: string) => boolean }) => void) | undefined,
  windowStateChanged: undefined as ((state: { focused: boolean; active: boolean }) => void) | undefined,
  woken: [] as string[],
}));

vi.mock('vscode', () => ({
  lm: { registerLanguageModelChatProvider: mocks.register },
  window: {
    createOutputChannel: () => mocks.output,
    registerWebviewViewProvider: mocks.registerView,
    onDidChangeWindowState: (callback: typeof mocks.windowStateChanged) => { mocks.windowStateChanged = callback; return { dispose() {} }; },
  },
  commands: { registerCommand: mocks.registerCommand },
  workspace: { onDidChangeConfiguration: (callback: typeof mocks.configurationChanged) => { mocks.configurationChanged = callback; return { dispose() {} }; }, getConfiguration: () => ({ get: (key: string, fallback?: unknown) => key.endsWith('.enabled') ? mocks.enabled && !mocks.disabledIds.has(key.split('.')[1]) : fallback }) },
  Uri: { joinPath: (...parts: unknown[]) => parts[0] },
}));
vi.mock('../../src/core/provider', () => ({
  AcpProvider: class {
    constructor(private readonly adapter: { id: string }, deps: { isEnabled: () => boolean }) { mocks.providerDeps.push(deps); }
    onDidMeasureRequest() { return { dispose() {} }; }
    onDidRequireSignIn() { return { dispose() {} }; }
    onDidFinishTurn() { return { dispose() {} }; }
    publishModels() { return Promise.resolve(); }
    restart() { return Promise.resolve(); }
    refresh() {}
    prepareAgent() { return Promise.resolve(true); }
    wakeAfterIdle() { mocks.woken.push(this.adapter.id); }
    askAgent(prompt: string) {
      if (this.adapter.id === 'codex' && prompt === '/status') {return Promise.resolve('**5h limit:** 58% left');}
      if (this.adapter.id === 'claude' && prompt === '/usage') {return Promise.resolve('**5-hour limit** — **42%**');}
      return Promise.resolve(undefined);
    }
    dispose() {}
  },
}));
vi.mock('../../src/core/bridge', () => ({
  McpBridge: class { dispose() {} },
}));
vi.mock('../../src/core/secrets', () => ({
  AgentSecretStore: class { get() { return Promise.resolve(undefined); } onDidChange() { return { dispose() {} }; } dispose() {} },
}));
vi.mock('../../src/sidebar/host', () => ({
  SidebarHost: class { constructor(deps: typeof mocks.sidebarControl[number]) { mocks.sidebarControl.push(deps); } },
}));
vi.mock('../../src/core/processes', () => ({ killStrayAgents() {}, killAllChildren() {} }));
// Google reads its quota from the Antigravity CLI's language server rather than through the chat.
vi.mock('../../src/adapters/googleHub', () => ({
  APP_DATA_DIR: 'antigravity-copilot',
  startHub: async () => ({ port: 1, token: 't', stop: async () => undefined }),
  callHub: async () => ({ response: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.75 }] }] } }),
}));
vi.mock('../../src/core/installers', () => ({
  findInstalled: async (adapter: { id: string }) => mocks.installedIds.has(adapter.id) ? { entryPath: 'agent', installDir: 'install' } : undefined,
  getInstallState() {}, installAgent() {}, uninstallAgent() {},
}));

import { activate } from '../../src/extension';

/** A shared store of its own for one test, so nothing touches the user's home folder. */
const storeRoots: string[] = [];

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-extension-'));
  storeRoots.push(root);
  process.env.ACP_HUB_HOME = root;
  mocks.enabled = true;
  mocks.disabledIds.clear();
  mocks.installedIds.clear();
  mocks.providerDeps.length = 0;
  mocks.sidebarControl.length = 0;
  mocks.register.mockClear();
  mocks.registerView.mockClear();
  mocks.woken.length = 0;
});

afterEach(async () => {
  delete process.env.ACP_HUB_HOME;
  // The store writes in the background; let those writes land before the folder goes.
  await new Promise(resolve => setTimeout(resolve, 50));
  for (const root of storeRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch { /* A leftover temp folder is not the test's business. */ }
  }
});

it('wakes the agents when the user is back in the window, not when it loses focus or goes idle', () => {
  activate({
    subscriptions: [],
    globalStorageUri: { fsPath: 'storage' },
    extensionUri: { fsPath: 'extension' },
    extension: { packageJSON: { version: '1' } },
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    secrets: {},
  } as never);

  mocks.windowStateChanged?.({ focused: false, active: false });
  mocks.windowStateChanged?.({ focused: true, active: false });
  expect(mocks.woken).toEqual([]);

  mocks.windowStateChanged?.({ focused: true, active: true });
  expect([...mocks.woken].sort()).toEqual(['claude', 'codex', 'google']);
});

it('registers a provider for every contributed vendor and the sidebar', () => {
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: 'storage' },
    extensionUri: { fsPath: 'extension' },
    extension: { packageJSON: { version: '1' } },
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    secrets: {},
  };
  activate(context as never);
  const vendors = mocks.register.mock.calls.map(call => call[0]);
  expect(vendors).toEqual(packageJson.contributes.languageModelChatProviders.map(item => item.vendor));
  expect(mocks.registerView).toHaveBeenCalledWith('acpHub.agents', expect.anything());
  expect(mocks.providerDeps[0].isEnabled()).toBe(true);
  mocks.enabled = false;
  expect(mocks.providerDeps[0].isEnabled()).toBe(false);
});

it('loads the usage of installed, enabled agents into the sidebar at startup', async () => {
  for (const id of ['claude', 'codex', 'google']) {mocks.installedIds.add(id);}
  activate({
    subscriptions: [],
    globalStorageUri: { fsPath: 'storage' },
    extensionUri: { fsPath: 'extension' },
    extension: { packageJSON: { version: '1' } },
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    secrets: {},
  } as never);

  // On Windows the Google quota is read on demand: the language server it needs opens a console window.
  const googleAtStartup = process.platform !== 'win32';
  await vi.waitFor(() => {
    const sidebar = mocks.sidebarControl[0];
    expect(sidebar.usage('claude').reading?.windows[0].usedPercent).toBe(42);
    expect(sidebar.usage('codex').reading?.windows[0].usedPercent).toBe(42);
    if (googleAtStartup) {
      expect(sidebar.usage('google').reading?.windows[0].usedPercent).toBe(25);
    }
  });
  if (!googleAtStartup) {
    expect(mocks.sidebarControl[0].usage('google').status).toBe('idle');
  }
});

it('does not start a usage read for disabled or uninstalled agents', async () => {
  mocks.installedIds.add('claude');
  mocks.installedIds.add('codex');
  mocks.disabledIds.add('codex');
  activate({
    subscriptions: [],
    globalStorageUri: { fsPath: 'storage' },
    extensionUri: { fsPath: 'extension' },
    extension: { packageJSON: { version: '1' } },
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    secrets: {},
  } as never);

  await vi.waitFor(() => expect(mocks.sidebarControl[0].usage('claude').status).toBe('ok'));
  expect(mocks.sidebarControl[0].usage('codex').status).toBe('idle');
  expect(mocks.sidebarControl[0].usage('google').status).toBe('idle');
});
