/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelPolicy } from '../../core/adapter';
import type { AcpConfigOption } from '../acp/protocol';

const MODEL_CATEGORY = 'model';
export const EFFORT_CATEGORY = 'thought_level';
/**
 * The agent-host model id suffix a copy of every model carries, so a picker that
 * filters by session type still lists it. The bare id is what the agent knows.
 */
export const AGENT_MODEL_ID_SUFFIX = '::agent';

export function findModelOption(configOptions: readonly AcpConfigOption[]): AcpConfigOption | undefined {
	return configOptions.find(option => option.category === MODEL_CATEGORY && option.type === 'select')
		?? configOptions.find(option => option.id === MODEL_CATEGORY && option.type === 'select');
}

export function findEffortOption(policy: ModelPolicy, configOptions: readonly AcpConfigOption[]): AcpConfigOption | undefined {
	return configOptions.find(option => option.id === policy.effortConfigId)
		?? configOptions.find(option => option.category === EFFORT_CATEGORY && option.type === 'select');
}

/**
 * The effort a request runs with. A request that names none, such as a subagent
 * started by the task tool, or that names the agent's own `default`, takes the
 * agent's `defaultEffort` setting when one is set, because the agent's own
 * choice can be the most expensive level.
 */
export function effortFor(requested: string | undefined, settings: { readonly [key: string]: unknown } | undefined): string | undefined {
	const configured = settings?.defaultEffort;
	if (typeof configured !== 'string' || configured === '' || configured === 'default') {
		return requested;
	}
	return requested === undefined || requested === 'default' ? configured : requested;
}

/** Maps a provider model id back to the model value the ACP agent understands. */
export function acpModelValue(modelId: string): string {
	return modelId.endsWith(AGENT_MODEL_ID_SUFFIX)
		? modelId.slice(0, -AGENT_MODEL_ID_SUFFIX.length)
		: modelId;
}
