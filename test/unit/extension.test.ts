import { expect, it, vi } from 'vitest';
import packageJson from '../../package.json';

const mocks = vi.hoisted(() => ({
  register: vi.fn((_vendor: string, _provider: unknown) => ({ dispose() {} })),
  registerView: vi.fn(() => ({ dispose() {} })),
  registerCommand: vi.fn(() => ({ dispose() {} })),
  output: { info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {} },
  enabled: true,
  providerDeps: [] as Array<{ isEnabled: () => boolean }>,
}));

vi.mock('vscode', () => ({
  lm: { registerLanguageModelChatProvider: mocks.register },
  window: { createOutputChannel: () => mocks.output, registerWebviewViewProvider: mocks.registerView },
  commands: { registerCommand: mocks.registerCommand },
  workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), getConfiguration: () => ({ get: () => mocks.enabled }) },
  Uri: { joinPath: (...parts: unknown[]) => parts[0] },
}));
vi.mock('../../src/core/provider', () => ({
  AcpProvider: class { constructor(_adapter: unknown, deps: { isEnabled: () => boolean }) { mocks.providerDeps.push(deps); } onDidMeasureRequest() { return { dispose() {} }; } onDidFinishTurn() { return { dispose() {} }; } publishModels() { return Promise.resolve(); } dispose() {} },
}));
vi.mock('../../src/core/bridge', () => ({
  McpBridge: class { dispose() {} },
}));
vi.mock('../../src/core/secrets', () => ({
  AgentSecretStore: class { onDidChange() { return { dispose() {} }; } dispose() {} },
}));
vi.mock('../../src/sidebar/host', () => ({
  SidebarHost: class {},
}));
vi.mock('../../src/core/processes', () => ({ killStrayAgents() {}, killAllChildren() {} }));

import { activate } from '../../src/extension';

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
