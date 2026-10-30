/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelPolicy } from '../core/adapter';

export const MODEL_FAMILY = 'codex';
export const MODEL_DETAIL = 'Codex ACP';
export const MAX_OUTPUT_TOKENS = 32_000;

/**
 * The window assumed for a model whose real size is not known yet, including any
 * model the adapter adds later. The catalogue never advertises a size; the adapter
 * reports the actual one in `usage_update.size` during a turn.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Context windows measured for Codex models, keyed by bare model id. Only add an
 * entry whose size was measured; {@link DEFAULT_CONTEXT_WINDOW} stands in until
 * `usage_update.size` reports the real one, which the provider then republishes
 * as that model's window.
 */
export const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {};

/** The order the adapter lists the effort levels in, which the picker follows. */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * The family a model is published under. Copilot chooses the prompt it renders
 * into the system message by this name, so a model whose id is one it knows
 * keeps that id: the chat then gets the prompt Copilot writes for that model
 * instead of its generic one. Everything else falls back to the agent's own
 * family, which matches no Copilot prompt.
 */
export function familyOf(modelValue: string): string {
	const value = modelValue.toLowerCase();
	return /^(?:gpt-|o\d)/.test(value) ? value : MODEL_FAMILY;
}

export function contextWindowOf(modelValue: string): number {
	return CONTEXT_WINDOWS[modelValue.replace(/\[[^\]]*\]$/, '')] ?? DEFAULT_CONTEXT_WINDOW;
}

function effortLabel(value: string): string {
	switch (value) {
		case 'low': return "Low";
		case 'medium': return "Medium";
		case 'high': return "High";
		case 'xhigh': return "Extra High";
		case 'max': return "Max";
		case 'ultra': return "Ultra";
		default: return value.charAt(0).toUpperCase() + value.slice(1);
	}
}

function effortDescription(value: string): string {
	switch (value) {
		case 'low': return "Fast responses with lighter reasoning";
		case 'medium': return "Balances speed and reasoning depth for everyday tasks";
		case 'high': return "Greater reasoning depth for complex problems";
		case 'xhigh': return "Extra high reasoning depth for complex problems";
		case 'max': return "Maximum reasoning depth for the hardest problems";
		case 'ultra': return "Maximum reasoning with automatic task delegation";
		default: return "Reasoning effort reported by the Codex agent.";
	}
}

/**
 * The effort levels the model catalogue advertises. A fresh session reports no
 * effort config option, only bracketed `model[effort]` pairs, so this is where
 * the picker's levels come from until a model has been resolved.
 */
export function effortLevelsFromModels(models: readonly { readonly modelId?: string }[]): string[] {
	const found = new Set<string>();
	for (const model of models) {
		const effort = /^[^[]+\[([^\]]+)\]$/.exec(model.modelId ?? '')?.[1];
		if (effort) {
			found.add(effort);
		}
	}

	// Unknown values follow the canonical ones, alphabetically, so a new effort
	// the adapter invents still shows up without being given a rank it lacks.
	const rank = (value: string) => {
		const index = EFFORT_ORDER.indexOf(value);
		return index === -1 ? EFFORT_ORDER.length : index;
	};
	return [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export const codexModelPolicy: ModelPolicy = {
	detail: MODEL_DETAIL,
	familyOf,
	contextWindowOf,
	maxOutputTokens: MAX_OUTPUT_TOKENS,
	effortConfigId: 'reasoning_effort',
	effortLabel,
	effortDescription,
	effortLevelsFromModels,
	defaultEffort: levels => levels[0],
	fallbackTooltip: name => `Codex model "${name}" served by the local Codex agent.`,
	thinkingDescription: "How much reasoning Codex spends before it answers.",
};
