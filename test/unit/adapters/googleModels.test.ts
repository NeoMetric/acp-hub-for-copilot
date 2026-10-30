/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_WINDOW, EXTENDED_CONTEXT_WINDOW, googleModelPolicy, MAX_OUTPUT_TOKENS } from '../../../src/adapters/googleModels';
import { flattenChoices, toModelVariants } from '../../../src/core/models';

const choices = flattenChoices([
	{ value: 'default', name: 'Default' },
	{ group: 'Older', options: [{ value: 'claude-opus-4-6', name: 'Opus 4.6' }] },
]);

describe('google contextWindowOf', () => {
	it.each([
		['default', '', EXTENDED_CONTEXT_WINDOW],
		['gemini-3.7-flash-high', '', EXTENDED_CONTEXT_WINDOW],
		['gemini-pro-agent', 'Gemini Pro', EXTENDED_CONTEXT_WINDOW],
		['something-unknown', '', EXTENDED_CONTEXT_WINDOW],
		['claude-opus-4-6', '', DEFAULT_CONTEXT_WINDOW],
		['claude-sonnet-4-6', 'Claude Sonnet', DEFAULT_CONTEXT_WINDOW],
		['gpt-oss-120b', '', DEFAULT_CONTEXT_WINDOW],
	])('%s %s -> %i', (value, name, expected) => {
		expect(googleModelPolicy.contextWindowOf(value, name)).toBe(expected);
	});
});

describe('google familyOf', () => {
	it('groups models by who made them', () => {
		expect(googleModelPolicy.familyOf('gemini-3.7-flash-high', '')).toBe('gemini');
		expect(googleModelPolicy.familyOf('claude-sonnet-4-6', '')).toBe('claude');
		expect(googleModelPolicy.familyOf('gpt-oss-120b', '')).toBe('gpt-oss');
		expect(googleModelPolicy.familyOf('default', 'Default')).toBe('gemini');
	});
});

describe('google model variants', () => {
	it('sizes the input window so that input plus output is the context window', () => {
		const [extended, , standard] = toModelVariants(googleModelPolicy, choices, []);

		expect(extended.maxInputTokens + extended.maxOutputTokens).toBe(EXTENDED_CONTEXT_WINDOW);
		expect(standard.maxInputTokens + standard.maxOutputTokens).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(extended.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
	});

	it('publishes the detail, family and tooltip', () => {
		const [first, , second] = toModelVariants(googleModelPolicy, choices, []);

		expect(first.detail).toBe('Google ACP');
		expect(first.family).toBe('gemini');
		expect(second.family).toBe('claude');
		expect(first.tooltip).toBe('Model "Default" served by the local Google agent.');
	});

	it('offers the thinking effort only when the agent reports levels', () => {
		const withEffort = toModelVariants(googleModelPolicy, choices, ['default', 'xhigh'])[0] as { configurationSchema?: { properties: Record<string, { description: string; enum: string[]; enumItemLabels: string[]; default: string }> } };
		const property = withEffort.configurationSchema!.properties.reasoningEffort;
		expect(property.description).toBe('How much reasoning the model spends before it answers.');
		expect(property.enum).toEqual(['default', 'xhigh']);
		expect(property.enumItemLabels).toEqual(['Default', 'Extra High']);
		expect(property.default).toBe('default');

		expect((toModelVariants(googleModelPolicy, choices, [])[0] as { configurationSchema?: unknown }).configurationSchema).toBeUndefined();
	});

	it('describes the efforts', () => {
		expect(googleModelPolicy.effortConfigId).toBe('effort');
		expect(googleModelPolicy.effortDescription('default')).toBe('Use the effort the agent picks for this model.');
		expect(googleModelPolicy.effortDescription('odd')).toBe('Effort level reported by the agent.');
	});
});
