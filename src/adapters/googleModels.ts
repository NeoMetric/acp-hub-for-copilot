/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelPolicy } from '../core/adapter';

export const MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * Context windows by model family. Gemini models have a 1M-token window; the
 * Claude and GPT-OSS models that Antigravity also serves are smaller. The
 * agent only reports a window once a turn has run, so the picker relies on
 * these patterns; revisit them when Google ships new model families.
 */
const GEMINI_MODEL = /gemini/i;
const THIRD_PARTY_MODEL = /claude|sonnet|opus|haiku|gpt|oss/i;

function effortLabel(value: string): string {
	switch (value) {
		case 'default': return "Default";
		case 'xhigh': return "Extra High";
		case 'max': return "Max";
		default: return value.charAt(0).toUpperCase() + value.slice(1);
	}
}

function effortDescription(value: string): string {
	switch (value) {
		case 'default': return "Use the effort the agent picks for this model.";
		case 'low': return "Minimal reasoning for the fastest answers.";
		case 'medium': return "Balanced reasoning for everyday tasks.";
		case 'high': return "Deeper reasoning for involved tasks.";
		case 'xhigh': return "Extended reasoning for difficult tasks.";
		case 'max': return "Maximum reasoning; the slowest, most thorough choice.";
		default: return "Effort level reported by the agent.";
	}
}

/** The model family the picker groups by, guessed from the model id and name. */
function familyOf(modelValue: string, modelName: string): string {
	const text = `${modelValue} ${modelName}`;
	if (/claude|sonnet|opus|haiku/i.test(text)) {
		return 'claude';
	}
	return /gpt|oss/i.test(text) && !GEMINI_MODEL.test(text) ? 'gpt-oss' : 'gemini';
}

function contextWindowOf(modelValue: string, modelName: string): number {
	const text = `${modelValue} ${modelName}`;
	return THIRD_PARTY_MODEL.test(text) && !GEMINI_MODEL.test(text)
		? DEFAULT_CONTEXT_WINDOW
		: EXTENDED_CONTEXT_WINDOW;
}

export const googleModelPolicy: ModelPolicy = {
	detail: 'Google ACP',
	familyOf,
	contextWindowOf,
	maxOutputTokens: MAX_OUTPUT_TOKENS,
	effortConfigId: 'effort',
	effortLabel,
	effortDescription,
	defaultEffort: levels => levels.includes('default') ? 'default' : levels[0],
	fallbackTooltip: name => `Model "${name}" served by the local Google agent.`,
	thinkingDescription: "How much reasoning the model spends before it answers.",
};
