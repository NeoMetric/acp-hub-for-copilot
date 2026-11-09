/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter, ModelChoice, ModelPolicy } from './adapter';
import type { AgentSession } from '../engine/acp/protocol';
import type { ModelInfoWire } from '../hosts/http/wire';
import { effortLevelsOf, findModelOption, flattenChoices, MODEL_VERSION } from './models';

/** The model picker's title for the thinking effort of every agent. */
const EFFORT_TITLE = 'Thinking Effort';

/** The models a session offers, and the thinking effort the agent accepts for them. */
export interface ModelChoices {
	readonly choices: ModelChoice[];
	readonly efforts: string[];
}

/** One model as the server publishes it: the value the agent knows it by, and the picker's metadata. */
export type ModelEntry = { readonly value: string; readonly info: ModelInfoWire };

/** The state key the models of an agent are saved under, which the extension reads and writes too. */
export function modelsStateKey(agentId: string): string {
	return `acpHub.models.${agentId}`;
}

/**
 * The models the agent offers, after the adapter has had its say about them.
 * Returns `undefined` when the agent reported no model option, so nothing can
 * be offered. Every per-agent decision comes from the adapter: its policy and
 * its own `listModels`.
 */
export function modelChoicesOf(adapter: AgentAdapter, session: AgentSession): ModelChoices | undefined {
	const modelOption = findModelOption(session.configOptions);
	if (!modelOption) {
		return undefined;
	}

	let choices: ModelChoice[] = flattenChoices(modelOption.options ?? []).map(choice => ({ value: choice.value, name: choice.name, description: choice.description ?? undefined }));
	// A fresh session may report no effort option, only bracketed `model[effort]`
	// ids: until a model is resolved, the catalogue is the only source.
	const reported = effortLevelsOf(adapter.modelPolicy, session.configOptions);
	const efforts = reported.length > 0 ? reported : adapter.modelPolicy.effortLevelsFromModels?.(session.models?.availableModels ?? []) ?? [];

	if (adapter.listModels) {
		const offered = choices.map((choice): ModelChoice => ({ value: choice.value, name: choice.name, description: choice.description ?? undefined }));
		choices = adapter.listModels({ models: offered, effortLevels: efforts }).map(choice => ({ value: choice.value, name: choice.name, description: choice.description }));
	}

	return { choices, efforts };
}

/**
 * The models of a session with everything the picker shows about them, as the
 * wire carries it. The context window is the one the agent reported for the
 * model when it has, and the policy's own until then.
 */
export function modelInfosOf(adapter: AgentAdapter, session: AgentSession, reportedWindows: ReadonlyMap<string, number> = new Map()): ModelEntry[] | undefined {
	const offered = modelChoicesOf(adapter, session);
	if (!offered) {
		return undefined;
	}
	return offered.choices.map(choice => ({
		value: choice.value,
		info: modelInfoOf(adapter.modelPolicy, choice, offered.efforts, reportedWindows.get(choice.value)),
	}));
}

function modelInfoOf(policy: ModelPolicy, choice: ModelChoice, efforts: readonly string[], reportedWindow: number | undefined): ModelInfoWire {
	const window = reportedWindow !== undefined && reportedWindow > policy.maxOutputTokens
		? reportedWindow
		: policy.contextWindowOf(choice.value, choice.name);
	const info: ModelInfoWire = {
		name: choice.name,
		family: policy.familyOf(choice.value, choice.name),
		version: MODEL_VERSION,
		detail: policy.detail,
		tooltip: choice.description ?? policy.fallbackTooltip(choice.name),
		// The picker shows the sum as the window, so the input share excludes the output.
		maxInputTokens: window - policy.maxOutputTokens,
		maxOutputTokens: policy.maxOutputTokens,
		toolCalling: true,
		imageInput: true,
		efforts: efforts.map(value => ({ value, label: policy.effortLabel(value), description: policy.effortDescription(value) })),
	};

	if (efforts.length > 0) {
		info.defaultEffort = policy.defaultEffort(efforts);
		info.effortTitle = EFFORT_TITLE;
		info.effortDescription = policy.thinkingDescription;
	}

	return info;
}
