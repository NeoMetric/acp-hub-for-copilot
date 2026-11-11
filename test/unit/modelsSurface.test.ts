import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import type { ModelEntry } from '../../src/core/modelInfo';
import { ModelNames } from '../../src/engine/models/modelNames';
import type { StateStore } from '../../src/engine/ports/state';
import { createModelsSurface, SAVED_NOTICE } from '../../src/hosts/http/modelsSurface';

function memoryState(): StateStore {
	const values: Record<string, unknown> = {};
	return { get: <T>(key: string) => values[key] as T | undefined, update: async (key, value) => { values[key] = value; }, keys: () => Object.keys(values) };
}

function adapterOf(id: string, displayName: string): AgentAdapter {
	return { id, displayName } as AgentAdapter;
}

function entry(value: string, name: string): ModelEntry {
	return { value, info: { name, family: 'f', version: '1', maxInputTokens: 1, maxOutputTokens: 1, toolCalling: true, imageInput: false, efforts: [] } };
}

const NOTHING_REFRESHED = 'No installed agent answered with models; the saved lists are unchanged.';

function setup(options: { usable?: (id: string) => boolean; refresh?: () => Promise<ModelEntry[]> } = {}) {
	const state = memoryState();
	const models: Record<string, ModelEntry[]> = { claude: [entry('sonnet', 'Sonnet 5.5'), entry('opus', 'Opus 5')], codex: [entry('gpt', 'GPT')] };
	const refresh = vi.fn(options.refresh ?? (async () => []));
	const surface = createModelsSurface({
		adapters: [adapterOf('claude', 'Claude Agent'), adapterOf('codex', 'Codex Agent')],
		usable: async adapter => options.usable?.(adapter.id) ?? true,
		names: new ModelNames(state),
		source: { savedOf: agentId => models[agentId] ?? [], refresh: async adapter => (await refresh(), models[adapter.id]) },
	});
	return { surface, refresh };
}

describe('the models surface', () => {
	it('shows each agent\'s names beside the ones the agent gives', async () => {
		const { surface } = setup();

		const view = await surface.view();

		expect(view.agents[0]).toEqual({
			agentId: 'claude',
			provider: { name: 'Claude Agent', default: 'Claude Agent' },
			models: [{ value: 'sonnet', name: 'Sonnet 5.5', default: 'Sonnet 5.5' }, { value: 'opus', name: 'Opus 5', default: 'Opus 5' }],
		});
	});

	it('never asks an agent for its models except on refresh', async () => {
		const { surface, refresh } = setup();

		await surface.view();
		await surface.setModelName('claude', 'sonnet', 'Fast one');
		await surface.setProviderName('claude', 'Work Claude');

		expect(refresh).not.toHaveBeenCalled();
	});

	it('saves the chosen names and asks the client to sync them', async () => {
		const { surface } = setup();

		expect(await surface.setModelName('claude', 'sonnet', 'Fast one')).toBe(SAVED_NOTICE);
		expect(await surface.setProviderName('claude', 'Work Claude')).toBe(SAVED_NOTICE);

		const view = await surface.view();
		expect(view.agents[0].provider.name).toBe('Work Claude');
		expect(view.agents[0].models[0].name).toBe('Fast one');
	});

	it('names no client of its own, since the server does not know which one syncs', async () => {
		const { surface } = setup();

		expect(await surface.setProviderName('claude', 'Work Claude')).not.toMatch(/VS Code|ACP Hub|Copilot/);
	});

	it('restores the agent\'s own name when a name is cleared', async () => {
		const { surface } = setup();
		await surface.setProviderName('claude', 'Work Claude');

		await surface.setProviderName('claude', '');

		expect((await surface.view()).agents[0].provider.name).toBe('Claude Agent');
	});

	it('refuses a duplicate name, says why, and stores nothing', async () => {
		const { surface } = setup();

		const notice = await surface.setProviderName('claude', 'codex agent');

		expect(notice).toMatch(/provider names must be different/);
		expect((await surface.view()).agents[0].provider.name).toBe('Claude Agent');
	});

	it('refreshes the models it can use, and names them', async () => {
		const { surface, refresh } = setup({ usable: id => id === 'claude' });

		expect(await surface.refresh()).toBe('Refreshed claude.');

		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('says the saved lists stand when no agent answered', async () => {
		const { surface } = setup({ usable: () => false });

		expect(await surface.refresh()).toBe(NOTHING_REFRESHED);
	});

	it('keeps the saved list when an agent cannot answer', async () => {
		const { surface } = setup({ refresh: async () => { throw new Error('agent down'); } });

		expect(await surface.refresh()).toBe(NOTHING_REFRESHED);
		expect((await surface.view()).agents[0].models).toHaveLength(2);
	});
});
