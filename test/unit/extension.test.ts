import { beforeEach, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';

const mocks = vi.hoisted(() => ({
  register: vi.fn((_vendor: string, _provider: unknown) => ({ dispose() {} })),
  registerView: vi.fn(() => ({ dispose() {} })),
  registerCommand: vi.fn(() => ({ dispose() {} })),
  output: { info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {} },
  enabled: true,
  disabledIds: new Set<string>(),
  installedIds: new Set<string>(),
  sidebarDeps: [] as Array<{ getUsage: (id: string) => { status: string; reading?: { windows: Array<{ usedPercent: number }> } } }>,
  providerDeps: [] as Array<{ isEnabled: () => boolean }>,
}));

vi.mock('vscode', () => ({
  lm: { registerLanguageModelChatProvider: mocks.register },
  window: { createOutputChannel: () => mocks.output, registerWebviewViewProvider: mocks.registerView },
  commands: { registerCommand: mocks.registerCommand },
  workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key: string, fallback?: unknown) => key.endsWith('.enabled') ? mocks.enabled && !mocks.disabledIds.has(key.split('.')[1]) : fallback }) },
  Uri: { joinPath: (...parts: unknown[]) => parts[0] },
}));
vi.mock('../../src/core/provider', () => ({
  AcpProvider: class {
    constructor(private readonly adapter: { id: string }, deps: { isEnabled: () => boolean }) { mocks.providerDeps.push(deps); }
    onDidMeasureRequest() { return { dispose() {} }; }
    onDidRequireSignIn() { return { dispose() {} }; }
    onDidFinishTurn() { return { dispose() {} }; }
    publishModels() { return Promise.resolve(); }
    askAgent(prompt: string) {
      if (this.adapter.id === 'google' && prompt === '/usage') {return Promise.resolve('### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 75% remaining');}
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
  SidebarHost: class { constructor(deps: typeof mocks.sidebarDeps[number]) { mocks.sidebarDeps.push(deps); } },
}));
vi.mock('../../src/core/processes', () => ({ killStrayAgents() {}, killAllChildren() {} }));
vi.mock('../../src/core/installers', () => ({
  findInstalled: async (adapter: { id: string }) => mocks.installedIds.has(adapter.id) ? { entryPath: 'agent', installDir: 'install' } : undefined,
  getInstallState() {}, installAgent() {}, uninstallAgent() {},
}));

import { activate } from '../../src/extension';

beforeEach(() => {
  mocks.enabled = true;
  mocks.disabledIds.clear();
  mocks.installedIds.clear();
  mocks.providerDeps.length = 0;
  mocks.sidebarDeps.length = 0;
  mocks.register.mockClear();
  mocks.registerView.mockClear();
});

it('registers a provider for every contributed vendor and the sidebar', () => {
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: 'storage' },
    extensionUri: { fsPath: 'extension' },
    extension: { packageJSON: { version: '1' } },
    globalState: {},
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
    globalState: {},
    secrets: {},
  } as never);

  await vi.waitFor(() => {
    const sidebar = mocks.sidebarDeps[0];
    expect(sidebar.getUsage('claude').reading?.windows[0].usedPercent).toBe(42);
    expect(sidebar.getUsage('codex').reading?.windows[0].usedPercent).toBe(42);
    expect(sidebar.getUsage('google').reading?.windows[0].usedPercent).toBe(25);
  });
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
    globalState: {},
    secrets: {},
  } as never);

  await vi.waitFor(() => expect(mocks.sidebarDeps[0].getUsage('claude').status).toBe('ok'));
  expect(mocks.sidebarDeps[0].getUsage('codex').status).toBe('idle');
  expect(mocks.sidebarDeps[0].getUsage('google').status).toBe('idle');
});
