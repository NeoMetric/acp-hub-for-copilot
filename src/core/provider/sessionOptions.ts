/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelPolicy } from '../adapter';
import type { Log } from '../logging';
import { acpModelValue, findEffortOption, findModelOption } from '../models';
import { RpcError } from '../rpc';
import type { AgentApi, ChatSession } from './types';

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The agent's own account of an RPC failure, which only the debug log may carry. */
export function rpcDetailsOf(error: unknown): string | undefined {
	const data = error instanceof RpcError ? error.data : undefined;
	const details = data && typeof data === 'object' ? (data as { details?: unknown }).details : undefined;
	return typeof details === 'string' && details.length > 0 ? details : undefined;
}

/**
 * Puts the model the picker chose on a session through the `model` config
 * option, which takes the bare id: a fresh session runs the agent's own
 * default, and a reopened one keeps the model it was saved with. When the
 * session already runs that model the bare set would change nothing, so for
 * agents that take `model[effort]` ids the effort goes with the model instead
 * of being left behind.
 */
export async function applyModel(agent: AgentApi, policy: ModelPolicy, session: ChatSession, effort: string | undefined, log: Log, label = ''): Promise<void> {
	const acp = session.acp;
	const option = findModelOption(acp.configOptions);
	if (!option) {
		return;
	}
	const wanted = acpModelValue(session.model);
	const current = String(option.currentValue);
	if (current !== wanted) {
		try {
			const configOptions = await agent.setConfigOption(acp.sessionId, option.id, wanted);
			if (configOptions) {
				acp.configOptions = configOptions;
			}
			log(`${label}Session ${acp.sessionId} now runs on "${wanted}" instead of "${current}"`);
		} catch (error) {
			// A model the agent no longer offers must not take the chat down: the
			// session keeps the model it has and the turn still runs.
			log(`${label}Could not set the model "${wanted}" (${describe(error)}); the session keeps "${current}".`, 'warn');
		}
	}
	if (effort && !findEffortOption(policy, acp.configOptions) && policy.effortLevelsFromModels) {
		await applyModelWithEffort(agent, session, effort, log, label);
	}
}

/**
 * Applies the model and the effort in the agent's single `session/set_model`
 * call, for a session whose `model` set resolves no effort option: the model
 * the session already runs, or one the catalogue does not hold. The call
 * returns nothing, so the options are read back with a write of the value
 * already in place. A refusal is reported once per model and effort, because
 * nothing else in the protocol can apply it.
 */
async function applyModelWithEffort(agent: AgentApi, session: ChatSession, effort: string, log: Log, label = ''): Promise<void> {
	const model = acpModelValue(session.model);
	const key = `${model}|${effort}`;
	if (session.effortFailure === key) {
		return;
	}
	try {
		await agent.setSessionModel(session.acp.sessionId, `${model}[${effort}]`);
	} catch (error) {
		session.effortFailure = key;
		log(`${label}Thinking effort "${effort}" was not applied to ${model}: the agent does not offer that effort for this model (${describe(error)}).`, 'warn');
		return;
	}
	session.effortFailure = undefined;
	try {
		const readBack = session.acp.configOptions.find(option => option.id === 'collaboration_mode')
			?? session.acp.configOptions[0];
		const configOptions = readBack
			? await agent.setConfigOption(session.acp.sessionId, readBack.id, readBack.currentValue ?? 'default')
			: undefined;
		if (configOptions) {
			session.acp.configOptions = configOptions;
		}
	} catch (error) {
		log(`${label}Could not read the session options back after setting the effort (${describe(error)}).`, 'debug');
	}
	log(`${label}Session ${session.acp.sessionId} runs on "${model}" with thinking effort "${effort}"`);
}

/**
 * Applies the thinking effort the picker reported. The option only exists once
 * a model has been resolved, so this runs after {@link applyModel}; for agents
 * that take `model[effort]` ids it falls back to the model-and-effort call when
 * there is still no option to write.
 */
export async function applyEffort(agent: AgentApi, policy: ModelPolicy, session: ChatSession, effort: string | undefined, log: Log): Promise<void> {
	if (!effort) {
		return;
	}
	const option = findEffortOption(policy, session.acp.configOptions);
	if (!option) {
		if (policy.effortLevelsFromModels) {
			await applyModelWithEffort(agent, session, effort, log);
		}
		return;
	}
	if (option.currentValue === effort) {
		session.effortFailure = undefined;
		return;
	}
	try {
		const configOptions = await agent.setConfigOption(session.acp.sessionId, option.id, effort);
		if (configOptions) {
			session.acp.configOptions = configOptions;
		}
		session.effortFailure = undefined;
		log(`Applied thinking effort "${effort}" to session ${session.acp.sessionId}`);
	} catch (error) {
		log(`Could not apply thinking effort "${effort}" to ${session.model}: ${describe(error)}`, 'warn');
	}
}

/** Switches a session to another model in place; returns false when the agent refuses and the session must be replaced. */
export async function switchModelInPlace(agent: AgentApi, session: ChatSession, modelId: string, key: string, log: Log): Promise<boolean> {
	const modelOption = findModelOption(session.acp.configOptions);
	if (!modelOption) {
		return false;
	}
	try {
		const configOptions = await agent.setConfigOption(session.acp.sessionId, modelOption.id, acpModelValue(modelId));
		if (configOptions) {
			session.acp.configOptions = configOptions;
		}
		session.model = modelId;
		log(`Switched session for ${key} to ${modelId}`);
		return true;
	} catch (error) {
		log(`Could not switch model in place (${describe(error)}); recreating the session.`, 'warn');
		return false;
	}
}
