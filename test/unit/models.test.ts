/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ModelPolicy } from '../../src/core/adapter';
import type { AcpConfigOption } from '../../src/core/agentClient';
import {
	acpModelValue, effortLevelsOf, effortOf, findEffortOption, findModelOption,
	flattenChoices, toModelVariants,
} from '../../src/core/models';

const BIG_WINDOW = 1_000_000;
const SMALL_WINDOW = 200_000;
const MAX_OUTPUT = 32_000;

const fakePolicy: ModelPolicy = {
	detail: 'Fake ACP',
	familyOf: (value, name) => `family:${value}:${name}`,
	contextWindowOf: value => value.startsWith('big') ? BIG_WINDOW : SMALL_WINDOW,
	maxOutputTokens: MAX_OUTPUT,
	effortConfigId: 'effort',
	effortLabel: value => value === 'xhigh' ? 'Extra High' : value.toUpperCase(),
	effortDescription: value => `about ${value}`,
	defaultEffort: levels => levels.includes('default') ? 'default' : levels[0],
	fallbackTooltip: name => `Fake model "${name}".`,
	thinkingDescription: 'Fake thinking.',
};

const modelOption: AcpConfigOption = {
	id: 'model',
	name: 'Model',
	category: 'model',
	type: 'select',
	options: [
		{ value: 'big-one', name: 'Big One' },
		{ group: 'Older', options: [{ value: 'small-two', name: 'Small Two', description: 'Described.' }] },
	],
};

const effortOption: AcpConfigOption = {
	id: 'effort',
	name: 'Effort',
	category: 'thought_level',
	type: 'select',
	options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }],
};

describe('config options', () => {
	it('finds the model and effort options', () => {
		expect(findModelOption([effortOption, modelOption])).toBe(modelOption);
		expect(findEffortOption(fakePolicy, [modelOption, effortOption])).toBe(effortOption);
		expect(findModelOption([effortOption])).toBeUndefined();
	});

	it('falls back to the option id and category', () => {
		const bare: AcpConfigOption = { id: 'model', name: 'M', type: 'select', options: [] };
		expect(findModelOption([bare])).toBe(bare);
		const byCategory: AcpConfigOption = { id: 'something', name: 'S', category: 'thought_level', type: 'select', options: [] };
		expect(findEffortOption(fakePolicy, [byCategory])).toBe(byCategory);
	});

	it('finds the effort option by the policy\'s config id', () => {
		const option: AcpConfigOption = { id: 'reasoning_effort', name: 'R', type: 'select', options: [{ value: 'low', name: 'Low' }] };
		const policy = { ...fakePolicy, effortConfigId: 'reasoning_effort' };

		expect(findEffortOption(fakePolicy, [option])).toBeUndefined();
		expect(findEffortOption(policy, [option])).toBe(option);
		expect(effortLevelsOf(policy, [option])).toEqual(['low']);
	});

	it('flattens grouped choices', () => {
		expect(flattenChoices(modelOption.options!).map(choice => choice.value)).toEqual(['big-one', 'small-two']);
	});

	it('lists the effort levels, or none', () => {
		expect(effortLevelsOf(fakePolicy, [effortOption])).toEqual(['default', 'high', 'xhigh']);
		expect(effortLevelsOf(fakePolicy, [modelOption])).toEqual([]);
	});
});

describe('toModelVariants', () => {
	const choices = flattenChoices(modelOption.options!);

	it('publishes every model twice: for chat and for the Copilot CLI agent', () => {
		const models = toModelVariants(fakePolicy, choices, ['default', 'high']);

		expect(models.map(model => model.id)).toEqual(['big-one', 'big-one::agent', 'small-two', 'small-two::agent']);
		const agentVariant = models[1] as vscode.LanguageModelChatInformation & { targetChatSessionType?: string };
		expect(agentVariant.targetChatSessionType).toBe('copilotcli');
		expect((models[0] as { targetChatSessionType?: string }).targetChatSessionType).toBeUndefined();
	});

	it('describes each model with the policy', () => {
		const [first, , second] = toModelVariants(fakePolicy, choices, []);

		expect(first.family).toBe('family:big-one:Big One');
		expect(first.detail).toBe('Fake ACP');
		expect(first.tooltip).toBe('Fake model "Big One".');
		expect(second.tooltip).toBe('Described.');
	});

	it('sizes the input window so that input plus output is the context window', () => {
		const [big, , small] = toModelVariants(fakePolicy, choices, []);

		expect(big.maxInputTokens + big.maxOutputTokens).toBe(BIG_WINDOW);
		expect(small.maxInputTokens + small.maxOutputTokens).toBe(SMALL_WINDOW);
		expect(big.maxOutputTokens).toBe(MAX_OUTPUT);
	});

	it('offers the thinking effort only when the agent reports levels', () => {
		const withEffort = toModelVariants(fakePolicy, choices, ['default', 'xhigh'])[0] as { configurationSchema?: { properties: Record<string, { description: string; enum: string[]; enumItemLabels: string[]; enumDescriptions: string[]; default: string }> } };
		const property = withEffort.configurationSchema!.properties.reasoningEffort;
		expect(property.description).toBe('Fake thinking.');
		expect(property.enum).toEqual(['default', 'xhigh']);
		expect(property.enumItemLabels).toEqual(['DEFAULT', 'Extra High']);
		expect(property.enumDescriptions).toEqual(['about default', 'about xhigh']);
		expect(property.default).toBe('default');

		expect((toModelVariants(fakePolicy, choices, [])[0] as { configurationSchema?: unknown }).configurationSchema).toBeUndefined();
	});

	it('takes the default effort from the policy', () => {
		const model = toModelVariants(fakePolicy, choices, ['low', 'high'])[0] as unknown as { configurationSchema: { properties: Record<string, { default: string }> } };

		expect(model.configurationSchema.properties.reasoningEffort.default).toBe('low');
	});

	it('declares tool calling and image input', () => {
		expect(toModelVariants(fakePolicy, choices, [])[0].capabilities).toEqual({ toolCalling: true, imageInput: true });
	});
});

describe('acpModelValue', () => {
	it('strips the agent suffix and nothing else', () => {
		expect(acpModelValue('opus::agent')).toBe('opus');
		expect(acpModelValue('opus')).toBe('opus');
	});
});

describe('effortOf', () => {
	const options = (extra: object) => ({ toolMode: 1, ...extra }) as unknown as vscode.ProvideLanguageModelChatResponseOptions;

	it('prefers the model configuration over the legacy model options', () => {
		expect(effortOf(options({ modelConfiguration: { reasoningEffort: 'high' }, modelOptions: { reasoningEffort: 'low' } }))).toBe('high');
		expect(effortOf(options({ modelOptions: { reasoningEffort: 'low' } }))).toBe('low');
	});

	it('ignores missing or empty values', () => {
		expect(effortOf(options({}))).toBeUndefined();
		expect(effortOf(options({ modelConfiguration: { reasoningEffort: '' } }))).toBeUndefined();
	});
});
