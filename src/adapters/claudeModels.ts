/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelPolicy } from '../core/adapter';

export const MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * Models with a native 1M-token context window, per Anthropic's context window
 * docs and the Claude Code model configuration docs. The agent only reports a
 * window once a turn has run, so the picker relies on this list; revisit it
 * when the adapter is bumped. The aliases resolve to the newest release.
 * Opus 4.6, Sonnet 4.6 and Haiku 4.5 reach 1M only through a `[1m]` variant,
 * which is recognised separately below.
 */
const EXTENDED_CONTEXT_MODEL = /^(default|opus|sonnet|haiku|fable)$|^claude-(opus|sonnet|fable)-5\b|^claude-haiku-5\b|^claude-opus-4-[78]\b/i;
const EXTENDED_CONTEXT_SUFFIX = /\[1m\]$/i;

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
		case 'default': return "Use the effort the Claude agent picks for this model.";
		case 'low': return "Minimal reasoning for the fastest answers.";
		case 'medium': return "Balanced reasoning for everyday tasks.";
		case 'high': return "Deeper reasoning for involved tasks.";
		case 'xhigh': return "Extended reasoning for difficult tasks.";
		case 'max': return "Maximum reasoning; the slowest, most thorough choice.";
		default: return "Effort level reported by the Claude agent.";
	}
}

export const claudeModelPolicy: ModelPolicy = {
	detail: 'Claude ACP',
	familyOf: () => 'claude',
	contextWindowOf: modelValue => EXTENDED_CONTEXT_MODEL.test(modelValue) || EXTENDED_CONTEXT_SUFFIX.test(modelValue)
		? EXTENDED_CONTEXT_WINDOW
		: DEFAULT_CONTEXT_WINDOW,
	maxOutputTokens: MAX_OUTPUT_TOKENS,
	effortConfigId: 'effort',
	effortLabel,
	effortDescription,
	defaultEffort: levels => levels.includes('default') ? 'default' : levels[0],
	fallbackTooltip: name => `Claude model "${name}" served by the local Claude agent.`,
	thinkingDescription: "How much reasoning Claude spends before it answers.",
};
