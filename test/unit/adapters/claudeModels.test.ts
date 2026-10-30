/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { claudeModelPolicy, DEFAULT_CONTEXT_WINDOW, EXTENDED_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS } from '../../../src/adapters/claudeModels';
import { flattenChoices, toModelVariants } from '../../../src/core/models';

const choices = flattenChoices([
	{ value: 'default', name: 'Default' },
	{ group: 'Older', options: [{ value: 'claude-opus-4-6', name: 'Opus 4.6' }] },
]);

describe('claude contextWindowOf', () => {
	it.each([
		['default', EXTENDED_CONTEXT_WINDOW],
		['opus', EXTENDED_CONTEXT_WINDOW],
		['claude-sonnet-5-5', EXTENDED_CONTEXT_WINDOW],
		['claude-opus-4-7', EXTENDED_CONTEXT_WINDOW],
		['claude-opus-4-6[1m]', EXTENDED_CONTEXT_WINDOW],
		['claude-opus-4-6', DEFAULT_CONTEXT_WINDOW],
		['claude-haiku-4-5', DEFAULT_CONTEXT_WINDOW],
		['something-unknown', DEFAULT_CONTEXT_WINDOW],
	])('%s -> %i', (model, expected) => {
		expect(claudeModelPolicy.contextWindowOf(model, '')).toBe(expected);
	});
});

describe('claude model variants', () => {
	it('sizes the input window so that input plus output is the context window', () => {
		const [extended, , standard] = toModelVariants(claudeModelPolicy, choices, []);

		expect(extended.maxInputTokens + extended.maxOutputTokens).toBe(EXTENDED_CONTEXT_WINDOW);
		expect(standard.maxInputTokens + standard.maxOutputTokens).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(extended.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
	});

	it('publishes the claude family and detail', () => {
		const [model] = toModelVariants(claudeModelPolicy, choices, []);

		expect(model.family).toBe('claude');
		expect(model.detail).toBe('Claude ACP');
		expect(model.tooltip).toBe('Claude model "Default" served by the local Claude agent.');
	});

	it('offers the thinking effort only when the agent reports levels', () => {
		const withEffort = toModelVariants(claudeModelPolicy, choices, ['default', 'xhigh'])[0] as { configurationSchema?: { properties: Record<string, { enum: string[]; enumItemLabels: string[]; default: string }> } };
		const property = withEffort.configurationSchema!.properties.reasoningEffort;
		expect(property.enum).toEqual(['default', 'xhigh']);
		expect(property.enumItemLabels).toEqual(['Default', 'Extra High']);
		expect(property.default).toBe('default');

		expect((toModelVariants(claudeModelPolicy, choices, [])[0] as { configurationSchema?: unknown }).configurationSchema).toBeUndefined();
	});

	it('defaults to the first level when there is no default one', () => {
		expect(claudeModelPolicy.defaultEffort(['high', 'low'])).toBe('high');
	});

	it('reads the effort from the effort config option', () => {
		expect(claudeModelPolicy.effortConfigId).toBe('effort');
	});

	it('labels and describes every effort', () => {
		expect(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'odd'].map(claudeModelPolicy.effortLabel))
			.toEqual(['Default', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Odd']);
		expect(claudeModelPolicy.effortDescription('max')).toBe('Maximum reasoning; the slowest, most thorough choice.');
		expect(claudeModelPolicy.effortDescription('odd')).toBe('Effort level reported by the Claude agent.');
	});
});
