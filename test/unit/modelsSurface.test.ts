import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import type { ModelEntry } from '../../src/core/modelInfo';
import { ModelNames } from '../../src/engine/models/modelNames';
import type { StateStore } from '../../src/engine/ports/state';
import { createModelsSurface } from '../../src/hosts/http/modelsSurface';

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) {
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

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

const TOKEN = 'tok-123';

function setup(options: { usable?: (id: string) => boolean; refresh?: () => Promise<ModelEntry[]>; manifest?: boolean } = {}) {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-surface-'));
	folders.push(folder);
	const providersFile = path.join(folder, 'providers.json');
	const packageJson = path.join(folder, 'package.json');
	if (options.manifest !== false) {
		fs.writeFileSync(packageJson, JSON.stringify({ contributes: { languageModelChatProviders: [{ vendor: 'Claude Agent', displayName: 'Claude Agent' }, { vendor: 'Codex Agent', displayName: 'Codex Agent' }] } }, null, '\t'));
	}
	const state = memoryState();
	const models: Record<string, ModelEntry[]> = { claude: [entry('sonnet', 'Sonnet 5.5'), entry('opus', 'Opus 5')], codex: [entry('gpt', 'GPT')] };
	const refresh = vi.fn(options.refresh ?? (async () => []));
	const surface = createModelsSurface({
		adapters: [adapterOf('claude', 'Claude Agent'), adapterOf('codex', 'Codex Agent')],
		usable: async adapter => options.usable?.(adapter.id) ?? true,
		names: new ModelNames(state),
		state,
		source: { savedOf: agentId => models[agentId] ?? [], refresh: async adapter => (await refresh(), models[adapter.id]) },
		token: TOKEN,
		baseUrl: () => 'http://127.0.0.1:8791/v1',
		providersFile,
		packageJson,
	});
	return { surface, providersFile, packageJson, refresh };
}

const read = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));

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

	it('never asks an agent for its models except on sync', async () => {
		const { surface, refresh } = setup();

		await surface.view();
		await surface.setModelName('claude', 'sonnet', 'Fast one');
		await surface.setProviderName('claude', 'Work Claude');

		expect(refresh).not.toHaveBeenCalled();
	});

	it('writes the chosen names to providers.json and package.json, and says what to reload', async () => {
		const { surface, providersFile, packageJson } = setup();

		await surface.setModelName('claude', 'sonnet', 'Fast one');
		const notice = await surface.setProviderName('claude', 'Work Claude');

		const config = read(providersFile);
		expect(config.providers[0]).toEqual({ name: 'Work Claude', type: 'openai', baseUrl: 'http://127.0.0.1:8791/v1', bearerToken: TOKEN });
		expect(config.models.filter((model: { provider: string }) => model.provider === 'Work Claude')).toEqual([
			{ id: 'Fast-one', provider: 'Work Claude', wireModel: 'claude/sonnet' },
			{ id: 'Opus-5', provider: 'Work Claude', wireModel: 'claude/opus' },
		]);
		expect(read(packageJson).contributes.languageModelChatProviders[0].displayName).toBe('Work Claude');
		expect(notice).toMatch(/Reload the VS Code window and restart the Copilot CLI/);
		expect(notice).not.toContain(TOKEN);
	});

	it('restores the agent\'s own name when a name is cleared', async () => {
		const { surface, packageJson } = setup();
		await surface.setProviderName('claude', 'Work Claude');

		await surface.setProviderName('claude', '');

		expect(read(packageJson).contributes.languageModelChatProviders[0].displayName).toBe('Claude Agent');
		expect((await surface.view()).agents[0].provider.name).toBe('Claude Agent');
	});

	it('leaves a disabled or uninstalled agent out of providers.json', async () => {
		const { surface, providersFile } = setup({ usable: id => id !== 'codex' });

		await surface.setProviderName('claude', 'Work Claude');

		expect(read(providersFile).providers.map((provider: { name: string }) => provider.name)).toEqual(['Work Claude']);
	});

	it('refuses a duplicate name, says why, and writes nothing', async () => {
		const { surface, providersFile } = setup();

		const notice = await surface.setProviderName('claude', 'codex agent');

		expect(notice).toMatch(/provider names must be different/);
		expect(fs.existsSync(providersFile)).toBe(false);
	});

	it('still writes providers.json when package.json cannot be updated, and says so', async () => {
		const { surface, providersFile } = setup({ manifest: false });

		const notice = await surface.setProviderName('claude', 'Work Claude');

		expect(read(providersFile).providers[0].name).toBe('Work Claude');
		expect(notice).toMatch(/package\.json/);
	});

	it('refreshes the models on sync, and goes on with the saved ones when a refresh fails', async () => {
		const { surface, providersFile, refresh } = setup({ refresh: async () => { throw new Error('agent down'); } });

		await surface.sync();

		expect(refresh).toHaveBeenCalled();
		expect(read(providersFile).models.length).toBe(3);
	});
});
