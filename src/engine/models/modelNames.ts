/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { StateStore } from '../ports/state';

/** The state key the names the user chose are saved under. */
export const MODEL_NAMES_KEY = 'server.modelNames';

/** The longest name the pickers are given. */
const MAX_NAME_LENGTH = 80;

/** The names the user chose; an agent or model that is absent shows its own. */
export interface NameOverrides {
	providers: Record<string, string>;
	models: Record<string, Record<string, string>>;
}

/** A name that cannot be used; the message says why, for the page to show. */
export class NameError extends Error { }

/** Display names the user chose for each agent's provider and models, kept in the state store. */
export class ModelNames {
	constructor(private readonly state: StateStore) { }

	overrides(): NameOverrides {
		const saved = this.state.get<unknown>(MODEL_NAMES_KEY);
		const result: NameOverrides = { providers: {}, models: {} };
		if (!isRecord(saved)) {
			return result;
		}
		if (isRecord(saved.providers)) {
			for (const [agentId, name] of Object.entries(saved.providers)) {
				if (typeof name === 'string') {
					result.providers[agentId] = name;
				}
			}
		}
		if (isRecord(saved.models)) {
			for (const [agentId, names] of Object.entries(saved.models)) {
				if (isRecord(names)) {
					result.models[agentId] = Object.fromEntries(Object.entries(names).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
				}
			}
		}
		return result;
	}

	providerName(agentId: string, fallback: string): string {
		return this.overrides().providers[agentId] ?? fallback;
	}

	modelName(agentId: string, value: string, fallback: string): string {
		return this.overrides().models[agentId]?.[value] ?? fallback;
	}

	/** Names an agent's provider, or restores its own name when `name` is empty; `defaults` holds every agent's own name. */
	async setProvider(agentId: string, name: string, defaults: ReadonlyMap<string, string>): Promise<void> {
		const cleaned = cleanName(name);
		const next = this.overrides();
		const shown = cleaned ?? defaults.get(agentId);
		if (shown !== undefined) {
			for (const [otherId, own] of defaults) {
				if (otherId !== agentId && sameName(next.providers[otherId] ?? own, shown)) {
					throw new NameError(`Another agent is already shown as "${shown}"; provider names must be different.`);
				}
			}
		}
		if (cleaned === undefined) {
			delete next.providers[agentId];
		} else {
			next.providers[agentId] = cleaned;
		}
		await this.state.update(MODEL_NAMES_KEY, next);
	}

	/** Names one model of an agent, or restores its own name when `name` is empty; `models` holds the agent's models with their own names. */
	async setModel(agentId: string, value: string, name: string, models: ReadonlyArray<{ value: string; name: string }>): Promise<void> {
		const cleaned = cleanName(name);
		const next = this.overrides();
		const own = models.find(model => model.value === value)?.name;
		const shown = cleaned ?? own;
		if (shown !== undefined) {
			for (const other of models) {
				if (other.value !== value && sameName(next.models[agentId]?.[other.value] ?? other.name, shown)) {
					throw new NameError(`Another model of this agent is already shown as "${shown}"; model names must be different.`);
				}
			}
		}
		const forAgent = { ...next.models[agentId] };
		if (cleaned === undefined) {
			delete forAgent[value];
		} else {
			forAgent[value] = cleaned;
		}
		if (Object.keys(forAgent).length > 0) {
			next.models[agentId] = forAgent;
		} else {
			delete next.models[agentId];
		}
		await this.state.update(MODEL_NAMES_KEY, next);
	}
}

/** The name trimmed, or `undefined` for an empty one; a name the pickers cannot show is refused. */
function cleanName(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed === '') {
		return undefined;
	}
	if (trimmed.length > MAX_NAME_LENGTH) {
		throw new NameError(`A name can be at most ${MAX_NAME_LENGTH} characters.`);
	}
	if ([...trimmed].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
		throw new NameError('A name cannot contain control characters.');
	}
	return trimmed;
}

function sameName(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
