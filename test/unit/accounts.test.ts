import { describe, expect, it } from 'vitest';
import type { AgentAdapter, LaunchContext } from '../../src/core/adapter';
import { accountAdapter, accountId, accountsSupported, isServing, readAccounts, validateAccountName } from '../../src/core/accounts';

function adapter(id: string, extra: Partial<AgentAdapter> = {}): AgentAdapter {
	return {
		id,
		displayName: `Agent ${id}`,
		vendor: `acphub-${id}`,
		install: { kind: 'download', version: '1', find: async () => undefined, install: async () => '' },
		launch: () => ({ command: id, args: [], env: {} }),
		auth: [],
		settings: [],
		modelPolicy: {} as AgentAdapter['modelPolicy'],
		...extra,
	};
}

const ctx: LaunchContext = { entryPath: 'e', installDir: '', storageDir: 'S', settings: {}, workspaceFolder: '.' };

function config(values: Record<string, unknown>) {
	return { get: <T>(name: string) => values[name] as T | undefined };
}

describe('accounts', () => {
	it('derives the id from the name', () => {
		expect(accountId('claude', 'Work')).toBe('claude-work');
		expect(accountId('claude', 'My  Team - 2')).toBe('claude-my-team-2');
	});

	it('refuses a name whose id is taken', () => {
		const existing = [{ id: 'claude-work', name: 'Work' }];
		const taken = new Set(['claude', 'codex', 'claude-work']);
		expect(validateAccountName('work', existing, taken, 'claude')).toMatch(/already/);
		expect(validateAccountName('WORK ', existing, taken, 'claude')).toMatch(/already/);
		expect(validateAccountName('Default', [], taken, 'claude')).toBeDefined();
		expect(validateAccountName('a/b', [], taken, 'claude')).toBeDefined();
		expect(validateAccountName('x'.repeat(21), [], taken, 'claude')).toBeDefined();
		expect(validateAccountName('', [], taken, 'claude')).toBeDefined();
		expect(validateAccountName('Team 2', [], taken, 'claude')).toBeUndefined();
	});

	it('copies an adapter as an account', () => {
		const base = adapter('claude', { accounts: { environment: dir => ({ CFG: `${dir}/cfg` }), inheritedCredentials: ['KEY'] } });
		const copy = accountAdapter(base, { id: 'claude-work', name: 'Work' });
		expect(copy).toMatchObject({ id: 'claude-work', installId: 'claude', accountName: 'Work', displayName: `${base.displayName} · Work`, vendor: `${base.vendor} · Work` });
		const spec = copy.launch(ctx);
		expect(spec.env.CFG).toBe('S/cfg');
		expect(spec.unsetEnv).toEqual(['KEY']);
	});

	it('keeps a credential the account set itself', () => {
		const base = adapter('claude', { launch: () => ({ command: 'c', args: [], env: { KEY: 'saved' } }), accounts: { environment: () => ({}), inheritedCredentials: ['KEY'] } });
		const spec = accountAdapter(base, { id: 'claude-work', name: 'Work' }).launch(ctx);
		expect(spec.env.KEY).toBe('saved');
		expect(spec.unsetEnv ?? []).not.toContain('KEY');
	});

	it('supports accounts only on Windows, for a base adapter that declares them', () => {
		const base = adapter('claude', { accounts: { environment: () => ({}), inheritedCredentials: [] } });
		expect(accountsSupported(base, 'win32')).toBe(true);
		expect(accountsSupported(base, 'darwin')).toBe(false);
		expect(accountsSupported(adapter('google'), 'win32')).toBe(false);
		expect(accountsSupported(accountAdapter(base, { id: 'claude-w', name: 'W' }), 'win32')).toBe(false);
	});

	it('serves only when the account and its type are both on', () => {
		const base = adapter('claude');
		const copy = accountAdapter(base, { id: 'claude-work', name: 'Work' });
		expect(isServing(copy, config({}))).toBe(true);
		expect(isServing(copy, config({ 'agents.claude-work.enabled': false }))).toBe(false);
		expect(isServing(copy, config({ 'agents.claude.accountsEnabled': false }))).toBe(false);
		expect(isServing(base, config({ 'agents.claude.accountsEnabled': false }))).toBe(false);
		expect(isServing(base, config({ 'agents.claude.enabled': false }))).toBe(false);
	});

	it('drops malformed, foreign, slashed and repeated records with a warning each', () => {
		const warnings: string[] = [];
		const records = readAccounts(config({
			'accounts.claude': [
				{ id: 'claude-work', name: 'Work' },
				{ id: 'claude-work', name: 'Work again' },
				{ id: 'codex-home', name: 'Home' },
				{ id: 'claude-a/b', name: 'Slash' },
				{ id: 'claude-..\\..\\x', name: 'Back' },
				{ id: 'claude-..', name: 'Dots' },
				{ id: 'claude-Work2', name: 'Upper' },
				{ id: 5, name: 'Bad' },
				'text',
				{ id: 'claude-team', name: 'Team' },
			],
		}), 'claude', message => warnings.push(message));
		expect(records).toEqual([{ id: 'claude-work', name: 'Work' }, { id: 'claude-team', name: 'Team' }]);
		expect(warnings).toHaveLength(8);
		expect(readAccounts(config({}), 'claude')).toEqual([]);
	});
});
