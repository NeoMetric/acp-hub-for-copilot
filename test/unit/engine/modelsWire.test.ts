/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import type { ModelEntry } from '../../../src/core/modelInfo';
import { modelsStateKey } from '../../../src/core/modelInfo';
import type { ModelWire } from '../../../src/hosts/http/wire';
import { closeServers, MOCK_MAX_OUTPUT, MOCK_POLICY, MOCK_WINDOW, mockAdapter, start } from './serverHarness';

const EFFORTS = [
	{ value: 'low', label: 'Low', description: 'about low' },
	{ value: 'medium', label: 'Medium', description: 'about medium' },
	{ value: 'high', label: 'High', description: 'about high' },
];

/** What an earlier run saved: a model the agent no longer offers. */
const SAVED: ModelEntry[] = [{
	value: 'seeded-1',
	info: {
		name: 'Seeded 1',
		family: 'seeded-1 family',
		version: '1',
		detail: 'Mock ACP',
		maxInputTokens: MOCK_WINDOW - MOCK_MAX_OUTPUT,
		maxOutputTokens: MOCK_MAX_OUTPUT,
		toolCalling: true,
		imageInput: true,
		efforts: [],
	},
}];

/** The models `GET /v1/models` answers with. */
async function modelsOf(url: string): Promise<ModelWire[]> {
	const response = await fetch(`${url}/v1/models`);
	expect(response.status).toBe(200);
	const body = await response.json() as { object: string; data: ModelWire[] };
	expect(body.object).toBe('list');
	return body.data;
}

/** The models once they satisfy the check, or the last list when they never do. */
async function waitForModels(url: string, check: (models: ModelWire[]) => boolean, timeoutMs = 15_000): Promise<ModelWire[]> {
	const deadline = Date.now() + timeoutMs;
	let models: ModelWire[] = [];
	while (Date.now() < deadline) {
		models = await modelsOf(url);
		if (check(models)) {
			return models;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return models;
}

afterEach(closeServers);

describe('the model list', () => {
	it('carries the picker metadata', async () => {
		const adapter = mockAdapter();
		const { url } = await start([{ adapter }]);

		const models = await modelsOf(url);

		expect(models.map(model => model.id)).toEqual([`${adapter.id}/mock-1`, `${adapter.id}/mock-2`]);
		const entry = models[0];
		expect(entry.object).toBe('model');
		expect(entry.owned_by).toBe(adapter.id);
		expect(entry.acp).toEqual({
			name: 'Mock 1',
			family: 'mock-1 family',
			version: '1',
			detail: MOCK_POLICY.detail,
			tooltip: 'The Mock 1 model of the mock agent.',
			maxInputTokens: MOCK_WINDOW - MOCK_MAX_OUTPUT,
			maxOutputTokens: MOCK_MAX_OUTPUT,
			toolCalling: true,
			imageInput: true,
			efforts: EFFORTS,
			defaultEffort: 'medium',
			effortTitle: 'Thinking Effort',
			effortDescription: MOCK_POLICY.thinkingDescription,
		});
		expect(entry.acp!.maxInputTokens + entry.acp!.maxOutputTokens).toBe(MOCK_WINDOW);
	});

	it('a reported context window narrows maxInputTokens', async () => {
		const adapter = mockAdapter();
		const running = await start([{ adapter }]);
		const first = await modelsOf(running.url);
		expect(first.find(model => model.id === `${adapter.id}/mock-1`)?.acp?.maxInputTokens).toBe(MOCK_WINDOW - MOCK_MAX_OUTPUT);

		running.reportWindow(adapter.id, 'mock-1', 120_000);

		const narrowed = (await modelsOf(running.url)).find(model => model.id === `${adapter.id}/mock-1`);
		expect(narrowed?.acp?.maxInputTokens).toBe(120_000 - MOCK_MAX_OUTPUT);
		expect(narrowed!.acp!.maxInputTokens + narrowed!.acp!.maxOutputTokens).toBe(120_000);
		const other = (await modelsOf(running.url)).find(model => model.id === `${adapter.id}/mock-2`);
		expect(other?.acp?.maxInputTokens).toBe(MOCK_WINDOW - MOCK_MAX_OUTPUT);
	});

	it('a cold model list answers from the saved copy', async () => {
		// The agent holds its session until the delay is over, as a slow start would.
		const adapter = mockAdapter({ env: { MOCK_ACP_NEW_DELAY_MS: '4000' } });
		const running = await start([{ adapter }]);
		await running.host.state.update(modelsStateKey(adapter.id), SAVED);

		const started = Date.now();
		const served = await modelsOf(running.url);
		const elapsedMs = Date.now() - started;

		expect(elapsedMs).toBeLessThan(1000);
		expect(served.map(model => model.id)).toEqual([`${adapter.id}/seeded-1`]);

		// The lookup the request started in the background replaces the saved copy once the agent answers.
		const fresh = await waitForModels(running.url, models => models.some(model => model.id === `${adapter.id}/mock-1`));
		expect(fresh.map(model => model.id)).toEqual([`${adapter.id}/mock-1`, `${adapter.id}/mock-2`]);
		expect(running.host.state.get<ModelEntry[]>(modelsStateKey(adapter.id))?.map(entry => entry.value)).toEqual(['mock-1', 'mock-2']);
	});

	it('keeps its cache apart from the extension\'s model list', async () => {
		// The extension saves LanguageModelChatInformation[] under its own key: the server must
		// neither publish that list nor overwrite it with the cache it keeps.
		const adapter = mockAdapter();
		const running = await start([{ adapter }]);
		const extensionKey = `acpHub.models.${adapter.id}`;
		const extensionList = [{
			id: 'plugin-model',
			name: 'Plugin Model',
			family: 'plugin',
			version: '1',
			maxInputTokens: 1000,
			maxOutputTokens: 100,
			toolCalling: true,
			imageInput: true,
		}];
		await running.host.state.update(extensionKey, extensionList);

		const models = await modelsOf(running.url);

		expect(models.map(model => model.id)).toEqual([`${adapter.id}/mock-1`, `${adapter.id}/mock-2`]);
		expect(running.host.state.get(extensionKey)).toEqual(extensionList);
		expect(running.host.state.get<ModelEntry[]>(modelsStateKey(adapter.id))?.map(entry => entry.value)).toEqual(['mock-1', 'mock-2']);
	});

	it('an agent that is not installed lists no models', async () => {
		const adapter = mockAdapter();
		const missing = mockAdapter({ id: 'missing' });
		const { url } = await start([{ adapter }, { adapter: missing, launch: async () => undefined }]);

		const models = await modelsOf(url);

		expect(models.some(model => model.owned_by === adapter.id)).toBe(true);
		expect(models.filter(model => model.owned_by === missing.id)).toEqual([]);
	});
});
