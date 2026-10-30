/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { ModelPolicy } from './adapter';
import type { AcpConfigOption, AcpConfigOptionChoice, AcpConfigOptionGroup } from './agentClient';

const MODEL_CATEGORY = 'model';
/** The model's own version is not known to the adapter; the picker only needs a stable value. */
const MODEL_VERSION = '1';

export const EFFORT_CATEGORY = 'thought_level';
/** The model configuration key the picker sends the chosen effort under. */
export const EFFORT_PROPERTY = 'reasoningEffort';
/** The model picker only shows a property in the toolbar when it is in this group. */
const EFFORT_GROUP = 'navigation';

/**
 * The Copilot CLI agent's chat session type. The chat model picker only lists
 * models that name the current session type, so every model is also published
 * with this target under a separate id (see {@link toModelVariants}).
 */
export const COPILOT_CLI_SESSION_TYPE = 'copilotcli';
export const AGENT_MODEL_ID_SUFFIX = '::agent';

export function findModelOption(configOptions: readonly AcpConfigOption[]): AcpConfigOption | undefined {
	return configOptions.find(option => option.category === MODEL_CATEGORY && option.type === 'select')
		?? configOptions.find(option => option.id === MODEL_CATEGORY && option.type === 'select');
}

export function findEffortOption(policy: ModelPolicy, configOptions: readonly AcpConfigOption[]): AcpConfigOption | undefined {
	return configOptions.find(option => option.id === policy.effortConfigId)
		?? configOptions.find(option => option.category === EFFORT_CATEGORY && option.type === 'select');
}

/** The effort values the agent accepts for the model it reported them for. */
export function effortLevelsOf(policy: ModelPolicy, configOptions: readonly AcpConfigOption[]): string[] {
	const option = findEffortOption(policy, configOptions);
	if (!option || option.type !== 'select') {
		return [];
	}
	return flattenChoices(option.options ?? []).map(choice => choice.value);
}

/** The effort the model picker sent with this request, if any. */
export function effortOf(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
	const configuration = (options as unknown as { modelConfiguration?: Record<string, unknown> }).modelConfiguration;
	const configured = configuration?.[EFFORT_PROPERTY];
	if (typeof configured === 'string' && configured.length > 0) {
		return configured;
	}
	const legacy = (options.modelOptions as Record<string, unknown> | undefined)?.[EFFORT_PROPERTY];
	return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

export function flattenChoices(options: ReadonlyArray<AcpConfigOptionChoice | AcpConfigOptionGroup>): AcpConfigOptionChoice[] {
	const choices: AcpConfigOptionChoice[] = [];

	for (const entry of options) {
		if ('options' in entry) {
			for (const choice of entry.options) {
				choices.push(choice);
			}
		} else {
			choices.push(entry);
		}
	}

	return choices;
}

export function toModelVariants(policy: ModelPolicy, choices: readonly AcpConfigOptionChoice[], effortLevels: readonly string[]): vscode.LanguageModelChatInformation[] {
	const models: vscode.LanguageModelChatInformation[] = [];

	for (const choice of choices) {
		models.push(toModelInformation(policy, choice, choice.value, effortLevels));
		// A copy aimed at the Copilot CLI agent: same model, distinct id. Without the
		// target the agent's picker filters the model out entirely.
		models.push(toModelInformation(policy, choice, `${choice.value}${AGENT_MODEL_ID_SUFFIX}`, effortLevels, COPILOT_CLI_SESSION_TYPE));
	}

	return models;
}

export function toModelInformation(policy: ModelPolicy, choice: AcpConfigOptionChoice, id: string, effortLevels: readonly string[], targetChatSessionType?: string): vscode.LanguageModelChatInformation {
	const info: vscode.LanguageModelChatInformation = {
		id,
		name: choice.name,
		family: policy.familyOf(choice.value, choice.name),
		version: MODEL_VERSION,
		detail: policy.detail,
		tooltip: choice.description ?? policy.fallbackTooltip(choice.name),
		// The picker shows the sum as the window, so the input share excludes the output.
		maxInputTokens: policy.contextWindowOf(choice.value, choice.name) - policy.maxOutputTokens,
		maxOutputTokens: policy.maxOutputTokens,
		capabilities: {
			toolCalling: true,
			imageInput: true,
		},
	};

	// Proposed API fields; VS Code reads both when building the picker and
	// ignores unknown properties otherwise.
	const configurable = info as unknown as { configurationSchema?: unknown; targetChatSessionType?: string };

	if (effortLevels.length > 0) {
		configurable.configurationSchema = {
			properties: {
				[EFFORT_PROPERTY]: {
					type: 'string',
					title: "Thinking Effort",
					description: policy.thinkingDescription,
					group: EFFORT_GROUP,
					enum: [...effortLevels],
					enumItemLabels: effortLevels.map(policy.effortLabel),
					enumDescriptions: effortLevels.map(policy.effortDescription),
					default: policy.defaultEffort(effortLevels),
				},
			},
		};
	}

	if (targetChatSessionType) {
		configurable.targetChatSessionType = targetChatSessionType;
	}

	return info;
}

/** Maps a provider model id back to the model value the ACP agent understands. */
export function acpModelValue(modelId: string): string {
	return modelId.endsWith(AGENT_MODEL_ID_SUFFIX)
		? modelId.slice(0, -AGENT_MODEL_ID_SUFFIX.length)
		: modelId;
}
