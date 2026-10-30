import { expect, it, vi } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude';
import { AcpProvider } from '../../src/core/provider';
import type { ProviderDeps } from '../../src/core/provider/types';
import { CancellationTokenSource } from './vscode-mock';

it('does not offer models or start a disabled agent', async () => {
	const resolveLaunch = vi.fn();
	const deps = {
		log: vi.fn(),
		bridge: {},
		state: undefined,
		resolveLaunch,
		isEnabled: () => false,
		client: {},
		signIn: vi.fn(),
		showOutput: vi.fn(),
	} as unknown as ProviderDeps;
	const provider = new AcpProvider(claudeAdapter, deps);
	const token = new CancellationTokenSource();
	expect(await provider.provideLanguageModelChatInformation({ silent: true }, token.token as never)).toEqual([]);
	expect(resolveLaunch).not.toHaveBeenCalled();
	provider.dispose();
});
