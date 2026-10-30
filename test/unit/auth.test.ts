import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, LaunchContext } from '../../src/core/adapter';
import { readSignInState, signIn, signInWithApiKey, signOut, terminalMethodsFrom, validateApiKey } from '../../src/core/auth';
import { AgentSecretStore } from '../../src/core/secrets';
import { FakeSecretStorage } from './secrets';

function makeAdapter(id: string, auth: AgentAdapter['auth']): AgentAdapter {
	return { id, displayName: `Test ${id}`, auth } as unknown as AgentAdapter;
}

const LOGIN = ['--cli', 'auth', 'login'];

const adapter = makeAdapter('a1', [
	{ kind: 'oauth-browser', label: 'Subscription', terminalCommand: LOGIN },
	{ kind: 'api-key', label: 'API key', envVar: 'KEY', keyPrefix: 'sk-test-' },
]);

const ctx = { entryPath: '/x/entry.js' } as LaunchContext;

function makeStore(): AgentSecretStore {
	return new AgentSecretStore(new FakeSecretStorage().asSecretStorage());
}

describe('terminalMethodsFrom', () => {
	it('keeps the login flows the agent advertises', () => {
		const methods = terminalMethodsFrom(adapter, [
			{ id: 'one', name: 'One', type: 'terminal', args: [...LOGIN, '--one'] },
			{ id: 'two', type: 'terminal', args: [...LOGIN, '--two'] },
		]);

		expect(methods).toEqual([
			{ kind: 'oauth-browser', label: 'One', terminalCommand: [...LOGIN, '--one'] },
			{ kind: 'oauth-browser', label: 'two', terminalCommand: [...LOGIN, '--two'] },
		]);
	});

	it('does not accept anything but the adapter\'s own login command', () => {
		const methods = terminalMethodsFrom(adapter, [
			{ id: 'evil', type: 'terminal', args: ['--eval', 'process.exit()'] },
			{ id: 'logout', type: 'terminal', args: ['--cli', 'auth', 'logout'] },
			{ id: 'not-a-terminal', type: 'agent', args: LOGIN },
			{ id: 'mixed', type: 'terminal', args: [...LOGIN, 42] },
			{ type: 'terminal', args: LOGIN },
			{ id: 'ok', type: 'terminal', args: [...LOGIN, '--console'] },
		]);

		expect(methods.map(method => method.label)).toEqual(['ok']);
	});

	it('falls back to the adapter\'s methods when nothing usable was advertised', () => {
		const fallback = [{ kind: 'oauth-browser', label: 'Subscription', terminalCommand: LOGIN }];
		expect(terminalMethodsFrom(adapter, [])).toEqual(fallback);
		expect(terminalMethodsFrom(adapter, [{ id: 'x', type: 'terminal', args: ['--bad'] }])).toEqual(fallback);
	});
});

describe('validateApiKey', () => {
	it('rejects empty or whitespace-containing input', () => {
		expect(validateApiKey('')?.severity).toBe('error');
		expect(validateApiKey('   ')?.severity).toBe('error');
		expect(validateApiKey('sk-a b')?.severity).toBe('error');
	});

	it('warns, but allows, a key without the usual prefix', () => {
		expect(validateApiKey('abc123', 'sk-')?.severity).toBe('warning');
	});

	it('accepts a key with the prefix, or any key when there is no prefix', () => {
		expect(validateApiKey('  sk-abc \n', 'sk-')).toBeUndefined();
		expect(validateApiKey('anything')).toBeUndefined();
	});
});

describe('signIn with an API key', () => {
	it('stores the trimmed key for that agent', async () => {
		const store = makeStore();
		const result = await signIn(adapter, { kind: 'api-key', key: '  sk-test-1 ' }, { store, ctx, runTerminal: vi.fn() });

		expect(result).toEqual({ ok: true });
		expect(await store.get('a1')).toBe('sk-test-1');
	});

	it('rejects an invalid key and stores nothing', async () => {
		const store = makeStore();
		const result = await signInWithApiKey('a1', 'a b', store);

		expect(result.ok).toBe(false);
		expect(await store.get('a1')).toBeUndefined();
	});

	it('does not collide between agents', async () => {
		const store = makeStore();
		await signInWithApiKey('a1', 'key-one', store);
		await signInWithApiKey('a2', 'key-two', store);

		expect(await store.get('a1')).toBe('key-one');
		expect(await store.get('a2')).toBe('key-two');
	});

	it('refuses an agent without an API key method', async () => {
		const store = makeStore();
		const noKey = makeAdapter('a3', [{ kind: 'oauth-browser', label: 'Login', terminalCommand: LOGIN }]);
		const result = await signIn(noKey, { kind: 'api-key', key: 'k' }, { store, ctx, runTerminal: vi.fn() });

		expect(result.ok).toBe(false);
		expect(await store.get('a3')).toBeUndefined();
	});
});

describe('signIn with a terminal', () => {
	it('runs the entry file with the login args and waits for the terminal to close', async () => {
		const runTerminal = vi.fn().mockResolvedValue(undefined);
		const method = { kind: 'oauth-browser' as const, label: 'Subscription', terminalCommand: [...LOGIN, '--x'] };

		const result = await signIn(adapter, { kind: 'terminal', method }, { store: makeStore(), ctx, runTerminal });

		expect(result).toEqual({ ok: true });
		expect(runTerminal).toHaveBeenCalledWith(expect.objectContaining({
			shellPath: process.execPath,
			shellArgs: ['/x/entry.js', ...LOGIN, '--x'],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		}));
	});

	it('rejects a method that does not match the allowed command', async () => {
		const runTerminal = vi.fn();
		const method = { kind: 'oauth-browser' as const, label: 'Evil', terminalCommand: ['--eval', 'x'] };

		const result = await signIn(adapter, { kind: 'terminal', method }, { store: makeStore(), ctx, runTerminal });

		expect(result.ok).toBe(false);
		expect(runTerminal).not.toHaveBeenCalled();
	});

	it('rejects a method that is not a terminal sign-in', async () => {
		const runTerminal = vi.fn();
		const method = { kind: 'agent-managed' as const, label: 'Managed' };

		const result = await signIn(adapter, { kind: 'terminal', method }, { store: makeStore(), ctx, runTerminal });

		expect(result.ok).toBe(false);
		expect(runTerminal).not.toHaveBeenCalled();
	});
});

describe('signOut', () => {
	it('removes only that agent\'s key', async () => {
		const store = makeStore();
		await store.set('a1', 'one');
		await store.set('a2', 'two');

		await signOut('a1', store);

		expect(await store.get('a1')).toBeUndefined();
		expect(await store.get('a2')).toBe('two');
	});
});

describe('readSignInState', () => {
	it('is yes with a saved key', async () => {
		const store = makeStore();
		await store.set('a1', 'one');

		expect(await readSignInState(adapter, { store })).toBe('yes');
	});

	it('is unknown with no key and no status', async () => {
		expect(await readSignInState(adapter, { store: makeStore() })).toBe('unknown');
	});

	it('uses what the agent reported when there is no key', async () => {
		const store = makeStore();
		expect(await readSignInState(adapter, { store, agentStatus: () => 'no' })).toBe('no');
		expect(await readSignInState(adapter, { store, agentStatus: () => 'yes' })).toBe('yes');
	});

	it('does not see another agent\'s key', async () => {
		const store = makeStore();
		await store.set('a2', 'two');

		expect(await readSignInState(adapter, { store })).toBe('unknown');
	});
});
