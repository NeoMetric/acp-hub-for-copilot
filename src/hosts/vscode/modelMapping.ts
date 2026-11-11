/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { AGENT_MODEL_ID_SUFFIX, COPILOT_CLI_SESSION_TYPE, EFFORT_PROPERTY, EFFORT_TITLE } from '../../core/models';
import type { ModelInfoWire, ModelWire } from '../http/wire';

/**
 * The server publishes a model as `<agentId>/<modelValue>`, because the chat
 * body names the agent that way. The picker shows the bare value: the body is
 * built from it, and the agent is added there. So the prefix is stripped here
 * and nowhere else.
 */

/** The model picker only shows a property in the toolbar when it is in this group. */
const EFFORT_GROUP = 'navigation';

/** The value the agent itself knows a model by, without the agent the wire names. */
export function bareModelValueOf(agentId: string, wireId: string): string {
	const prefix = `${agentId}/`;
	return wireId.startsWith(prefix) ? wireId.slice(prefix.length) : wireId;
}

/** The wire model of a saved entry, or `undefined` when the entry is not in a shape the picker can show. */
export function modelWireOfSaved(agentId: string, saved: unknown): ModelWire | undefined {
	if (typeof saved !== 'object' || saved === null) {
		return undefined;
	}
	const { value, info } = saved as { value?: unknown; info?: Partial<ModelInfoWire> };
	if (typeof value !== 'string' || typeof info !== 'object' || info === null
		|| typeof info.name !== 'string' || typeof info.maxInputTokens !== 'number' || typeof info.maxOutputTokens !== 'number') {
		return undefined;
	}
	return {
		id: `${agentId}/${value}`,
		object: 'model',
		created: 0,
		owned_by: agentId,
		acp: { ...info as ModelInfoWire, efforts: Array.isArray(info.efforts) ? info.efforts : [] },
	};
}

/**
 * The picker entries of one wire model: the plain one and the copy aimed at the
 * Copilot CLI agent (which filters out models that do not name its session type).
 * A `target` of `'agent'` builds that copy alone.
 */
export function modelInformationOf(agentId: string, model: ModelWire, target?: 'agent'): vscode.LanguageModelChatInformation[] {
	const info = model.acp;
	if (!info) {
		return [];
	}
	const value = bareModelValueOf(agentId, model.id);
	if (target === 'agent') {
		return [variantOf(info, `${value}${AGENT_MODEL_ID_SUFFIX}`, COPILOT_CLI_SESSION_TYPE)];
	}
	return [
		variantOf(info, value),
		variantOf(info, `${value}${AGENT_MODEL_ID_SUFFIX}`, COPILOT_CLI_SESSION_TYPE),
	];
}

function variantOf(info: ModelInfoWire, id: string, targetChatSessionType?: string): vscode.LanguageModelChatInformation {
	const model: vscode.LanguageModelChatInformation = {
		id,
		name: info.name,
		family: info.family,
		version: info.version,
		detail: info.detail,
		tooltip: info.tooltip,
		maxInputTokens: info.maxInputTokens,
		maxOutputTokens: info.maxOutputTokens,
		capabilities: {
			toolCalling: info.toolCalling,
			imageInput: info.imageInput,
		},
	};

	// Proposed API fields; VS Code reads both when building the picker and
	// ignores unknown properties otherwise.
	const configurable = model as unknown as { configurationSchema?: unknown; targetChatSessionType?: string };

	if (info.efforts.length > 0) {
		configurable.configurationSchema = {
			properties: {
				[EFFORT_PROPERTY]: {
					type: 'string',
					title: info.effortTitle ?? EFFORT_TITLE,
					description: info.effortDescription,
					group: EFFORT_GROUP,
					enum: info.efforts.map(effort => effort.value),
					enumItemLabels: info.efforts.map(effort => effort.label),
					enumDescriptions: info.efforts.map(effort => effort.description),
					default: info.defaultEffort ?? info.efforts[0].value,
				},
			},
		};
	}

	if (targetChatSessionType) {
		configurable.targetChatSessionType = targetChatSessionType;
	}

	return model;
}
