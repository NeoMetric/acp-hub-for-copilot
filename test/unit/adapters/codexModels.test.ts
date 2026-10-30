/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	CONTEXT_WINDOWS, codexModelPolicy, contextWindowOf, DEFAULT_CONTEXT_WINDOW, effortLevelsFromModels, familyOf, MAX_OUTPUT_TOKENS, MODEL_DETAIL, MODEL_FAMILY,
} from '../../../src/adapters/codexModels';
import type { AcpConfigOption } from '../../../src/core/agentClient';
import { effortLevelsOf, findEffortOption, flattenChoices, toModelVariants } from '../../../src/core/models';

const modelOption: AcpConfigOption = {
	id: 'model',
	name: 'Model',
	category: 'model',
	type: 'select',
	currentValue: 'gpt-5.4',
	options: [
		{ value: 'gpt-5.4', name: '5.4', description: null },
		{ group: 'Older', options: [{ value: 'gpt-6.1-sol', name: '6.1 Sol' }] },
	],
};

const effortOption: AcpConfigOption = {
	id: 'reasoning_effort',
	name: 'Reasoning effort',
	description: 'How much reasoning effort the model should use',
	category: 'thought_level',
	type: 'select',
	currentValue: 'low',
	options: [
		{ value: 'low', name: 'Low' },
		{ value: 'medium', name: 'Medium' },
		{ value: 'high', name: 'High' },
		{ value: 'xhigh', name: 'Xhigh' },
		{ value: 'max', name: 'Max' },
		{ value: 'ultra', name: 'Ultra' },
	],
};

const choices = flattenChoices(modelOption.options ?? []);

describe('codex config options', () => {
	it('reads reasoning_effort by id and by category', () => {
		const option: AcpConfigOption = { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', options: [{ value: 'low', name: 'Low' }] };

		expect(findEffortOption(codexModelPolicy, [option])).toBe(option);
		expect(effortLevelsOf(codexModelPolicy, [option])).toEqual(['low']);
	});

	it('lists the effort levels, or none', () => {
		expect(effortLevelsOf(codexModelPolicy, [effortOption])).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
		expect(effortLevelsOf(codexModelPolicy, [modelOption])).toEqual([]);
	});
});

describe('effortLevelsFromModels', () => {
	const models = (...modelIds: string[]) => modelIds.map(modelId => ({ modelId, name: modelId, description: null }));

	it('reads the bracketed effort, de-duplicates it and uses the canonical order', () => {
		const available = models('gpt-6.1-sol[medium]', 'gpt-5.4[low]', 'gpt-6-sol[medium]', 'gpt-6.1-sol[high]', 'gpt-6.1-sol[ultra]', 'gpt-6.1-sol[xhigh]', 'gpt-6.1-sol[max]');

		expect(effortLevelsFromModels(available)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
	});

	it('puts an unknown value after the canonical ones, alphabetically', () => {
		expect(effortLevelsFromModels(models('gpt-6.1-sol[zap]', 'gpt-6.1-sol[low]', 'gpt-6.1-sol[aside]'))).toEqual(['low', 'aside', 'zap']);
	});

	it('is empty when nothing parses', () => {
		expect(effortLevelsFromModels(models('gpt-5.4'))).toEqual([]);
		expect(effortLevelsFromModels([])).toEqual([]);
	});

	it('is the policy\'s way of reading levels', () => {
		expect(codexModelPolicy.effortLevelsFromModels).toBe(effortLevelsFromModels);
	});
});

describe('codex contextWindowOf', () => {
	it('falls back to the default for an id no measurement covers', () => {
		expect(contextWindowOf('gpt-5.4')).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(contextWindowOf('gpt-6.1-sol[low]')).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(contextWindowOf('something-unknown')).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it('answers every id the table holds with the size in it', () => {
		for (const [id, size] of Object.entries(CONTEXT_WINDOWS)) {
			expect(contextWindowOf(id)).toBe(size);
		}
	});
});

describe('codex model variants', () => {
	it('publishes the id Copilot knows as the family, and codex for the rest', () => {
		const [model, , other] = toModelVariants(codexModelPolicy, choices, []);

		expect(MODEL_FAMILY).toBe('codex');
		expect(model.family).toBe('gpt-5.4');
		expect(other.family).toBe('gpt-6.1-sol');
		expect(familyOf('o3-mini')).toBe('o3-mini');
		expect(familyOf('codex-mini-latest')).toBe(MODEL_FAMILY);
		expect(familyOf('GPT-5.1-Codex')).toBe('gpt-5.1-codex');
		expect(MODEL_DETAIL).toBe('Codex ACP');
		expect(model.detail).toBe(MODEL_DETAIL);
		expect(model.tooltip).toBe('Codex model "5.4" served by the local Codex agent.');
	});

	it('sizes the input window so that input plus output is the context window', () => {
		const [first, , second] = toModelVariants(codexModelPolicy, choices, []);

		expect(first.maxInputTokens + first.maxOutputTokens).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(second.maxInputTokens + second.maxOutputTokens).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(first.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
	});

	it('labels and describes the Codex efforts', () => {
		const [model] = toModelVariants(codexModelPolicy, choices, ['low', 'medium', 'high', 'xhigh']);
		const property = (model as unknown as { configurationSchema: { properties: Record<string, Record<string, unknown>> } }).configurationSchema.properties.reasoningEffort;

		expect(model.family).toBe('gpt-5.4');
		expect(property.enumItemLabels).toEqual(['Low', 'Medium', 'High', 'Extra High']);
	});

	it('describes every effort with the wording the adapter sends', () => {
		const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
		const [model] = toModelVariants(codexModelPolicy, choices, levels);
		const property = (model as unknown as { configurationSchema: { properties: Record<string, { enum: string[]; enumItemLabels: string[]; enumDescriptions: string[]; default: string }> } })
			.configurationSchema.properties.reasoningEffort;

		expect(property.enum).toEqual(levels);
		expect(property.enumItemLabels).toEqual(['Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra']);
		expect(property.enumDescriptions).toEqual([
			'Fast responses with lighter reasoning',
			'Balances speed and reasoning depth for everyday tasks',
			'Greater reasoning depth for complex problems',
			'Extra high reasoning depth for complex problems',
			'Maximum reasoning depth for the hardest problems',
			'Maximum reasoning with automatic task delegation',
		]);
		expect(property.default).toBe('low');
	});

	it('offers the thinking effort only when the agent reports levels', () => {
		expect((toModelVariants(codexModelPolicy, choices, [])[0] as { configurationSchema?: unknown }).configurationSchema).toBeUndefined();
	});

	it('declares tool calling and image input', () => {
		expect(toModelVariants(codexModelPolicy, choices, [])[0].capabilities).toEqual({ toolCalling: true, imageInput: true });
	});
});
