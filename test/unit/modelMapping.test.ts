/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ModelChoice, ModelPolicy } from '../../src/core/adapter';
import { AGENT_MODEL_ID_SUFFIX, COPILOT_CLI_SESSION_TYPE, EFFORT_PROPERTY, EFFORT_TITLE, MODEL_VERSION, toModelInformation } from '../../src/core/models';
import type { ModelInfoWire, ModelWire } from '../../src/hosts/http/wire';
import { modelInformationOf } from '../../src/hosts/vscode/modelMapping';

/** The picker's view of a model, including the fields the proposed API adds. */
type Configurable = {
	configurationSchema?: { properties?: Record<string, Record<string, unknown>> };
	targetChatSessionType?: string;
};

const policy: ModelPolicy = {
	detail: 'Test Agent',
	familyOf: (value: string) => value,
	contextWindowOf: () => 200_000,
	maxOutputTokens: 64_000,
	effortConfigId: 'effort',
	effortLabel: value => value[0].toUpperCase() + value.slice(1),
	effortDescription: value => `Thinks ${value}.`,
	defaultEffort: levels => levels.includes('default') ? 'default' : levels[0],
	fallbackTooltip: name => `The ${name} model.`,
	thinkingDescription: 'How hard the model thinks.',
};

const choice: ModelChoice = { value: 'claude-sonnet-4', name: 'Sonnet 4.6', description: 'The balanced one.' };

/** The wire entry the server publishes for one model, built the way its model cache builds it. */
function wireOf(model: ModelChoice = choice, efforts: readonly string[] = ['low', 'high']): ModelWire {
	const info: ModelInfoWire = {
		name: model.name,
		family: policy.familyOf(model.value, model.name),
		version: MODEL_VERSION,
		detail: policy.detail,
		tooltip: model.description ?? policy.fallbackTooltip(model.name),
		maxInputTokens: policy.contextWindowOf(model.value, model.name) - policy.maxOutputTokens,
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
	return { id: `claude/${model.value}`, object: 'model', created: 1_700_000_000, owned_by: 'claude', acp: info };
}

const proposed = (model: vscode.LanguageModelChatInformation) => model as unknown as Configurable;

describe('modelInformationOf', () => {
	it('each model yields a plain and an ::agent entry', () => {
		const models = modelInformationOf('claude', wireOf());

		expect(models.map(model => model.id)).toEqual([choice.value, `${choice.value}${AGENT_MODEL_ID_SUFFIX}`]);
		expect(proposed(models[0]).targetChatSessionType).toBeUndefined();
		expect(proposed(models[1]).targetChatSessionType).toBe(COPILOT_CLI_SESSION_TYPE);
		expect(models[1].name).toBe(models[0].name);
	});

	it('the effort schema matches the one AcpProvider published', () => {
		const efforts = ['low', 'high'];
		const models = modelInformationOf('claude', wireOf(choice, efforts));

		expect(models[0]).toEqual(toModelInformation(policy, choice, choice.value, efforts));
		expect(proposed(models[0]).configurationSchema?.properties?.[EFFORT_PROPERTY]).toEqual({
			type: 'string',
			title: EFFORT_TITLE,
			description: policy.thinkingDescription,
			group: 'navigation',
			enum: efforts,
			enumItemLabels: efforts.map(policy.effortLabel),
			enumDescriptions: efforts.map(policy.effortDescription),
			default: 'low',
		});
	});

	it('a model with no efforts has no configurationSchema', () => {
		const models = modelInformationOf('claude', wireOf(choice, []));

		expect(proposed(models[0]).configurationSchema).toBeUndefined();
		expect(proposed(models[1]).configurationSchema).toBeUndefined();
	});

	it('keeps the id bare, without the agent prefix the wire carries', () => {
		const models = modelInformationOf('claude', wireOf());

		expect(models.some(model => model.id.includes('claude/'))).toBe(false);
	});
});
