import { describe, expect, it } from 'vitest';
import { ModelNames, MODEL_NAMES_KEY, NameError } from '../../src/engine/models/modelNames';
import type { StateStore } from '../../src/engine/ports/state';

function memoryState(initial: Record<string, unknown> = {}): StateStore & { values: Record<string, unknown> } {
	const values = { ...initial };
	return {
		values,
		get: <T>(key: string) => values[key] as T | undefined,
		update: async (key, value) => { values[key] = value; },
		keys: () => Object.keys(values),
	};
}

const DEFAULTS = new Map([['claude', 'Claude Agent'], ['codex', 'Codex Agent']]);
const MODELS = [{ value: 'a', name: 'Alpha' }, { value: 'b', name: 'Beta' }];

describe('ModelNames', () => {
	it('stores a trimmed provider name and falls back to the default until then', async () => {
		const state = memoryState();
		const names = new ModelNames(state);
		expect(names.providerName('claude', 'Claude Agent')).toBe('Claude Agent');

		await names.setProvider('claude', '  Work Claude ', DEFAULTS);

		expect(names.providerName('claude', 'Claude Agent')).toBe('Work Claude');
		expect(names.overrides().providers).toEqual({ claude: 'Work Claude' });
	});

	it('stores a model name per agent and model', async () => {
		const names = new ModelNames(memoryState());
		await names.setModel('claude', 'a', 'Fast one', MODELS);
		expect(names.modelName('claude', 'a', 'Alpha')).toBe('Fast one');
		expect(names.modelName('claude', 'b', 'Beta')).toBe('Beta');
	});

	it('clears an override with an empty name', async () => {
		const names = new ModelNames(memoryState());
		await names.setProvider('claude', 'Work Claude', DEFAULTS);
		await names.setProvider('claude', '   ', DEFAULTS);
		expect(names.providerName('claude', 'Claude Agent')).toBe('Claude Agent');
		expect(names.overrides().providers).toEqual({});

		await names.setModel('claude', 'a', 'Fast one', MODELS);
		await names.setModel('claude', 'a', '', MODELS);
		expect(names.modelName('claude', 'a', 'Alpha')).toBe('Alpha');
	});

	it('refuses a name that is too long or holds a control character', async () => {
		const state = memoryState();
		const names = new ModelNames(state);
		await expect(names.setProvider('claude', 'x'.repeat(81), DEFAULTS)).rejects.toBeInstanceOf(NameError);
		await expect(names.setModel('claude', 'a', 'two\nlines', MODELS)).rejects.toBeInstanceOf(NameError);
		expect(state.values[MODEL_NAMES_KEY]).toBeUndefined();
	});

	it('refuses a model name another model of the agent already shows, and saves nothing', async () => {
		const state = memoryState();
		const names = new ModelNames(state);
		await expect(names.setModel('claude', 'a', 'beta', MODELS)).rejects.toBeInstanceOf(NameError);
		expect(state.values[MODEL_NAMES_KEY]).toBeUndefined();
	});

	it('refuses a provider name another agent already shows', async () => {
		const names = new ModelNames(memoryState());
		await expect(names.setProvider('claude', 'codex agent', DEFAULTS)).rejects.toBeInstanceOf(NameError);
		await names.setProvider('codex', 'Mine', DEFAULTS);
		await expect(names.setProvider('claude', 'mine', DEFAULTS)).rejects.toBeInstanceOf(NameError);
	});

	it('reads a value of the wrong shape as no overrides', () => {
		const names = new ModelNames(memoryState({ [MODEL_NAMES_KEY]: 42 }));
		expect(names.overrides()).toEqual({ providers: {}, models: {} });
	});
});
