/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter } from '../../core/adapter';
import type { ModelEntry } from '../../core/modelInfo';
import { NameError, type ModelNames } from '../../engine/models/modelNames';
import type { ModelsSurface, ModelsView } from '../../ui/messages';

/** What the page says after a name is saved, since the pickers pick the name up when their own client syncs. */
export const SAVED_NOTICE = 'Saved. Sync the model pickers from your client to show the new name.';

const NOTHING_REFRESHED = 'No installed agent answered with models; the saved lists are unchanged.';

export interface ModelsSurfaceDeps {
	readonly adapters: readonly AgentAdapter[];
	/** Whether the agent is enabled and on this machine, which is what decides that it is offered. */
	usable(adapter: AgentAdapter): Promise<boolean>;
	readonly names: ModelNames;
	readonly source: {
		/** The models saved for the agent; reading them never starts it. */
		savedOf(agentId: string): ModelEntry[];
		/** A lookup now, which may start the agent. */
		refresh(adapter: AgentAdapter): Promise<ModelEntry[]>;
	};
}

export function createModelsSurface(deps: ModelsSurfaceDeps): ModelsSurface {
	const { adapters, names } = deps;

	/** The agent's models as saved, or none when it is not offered; the saved list is what the pickers keep when the agent cannot answer. */
	const modelsOf = async (adapter: AgentAdapter): Promise<ModelEntry[]> => {
		if (!await deps.usable(adapter)) {
			return [];
		}
		return deps.source.savedOf(adapter.id);
	};

	const defaultProviders = (): Map<string, string> => new Map(adapters.map(adapter => [adapter.id, adapter.displayName]));

	/** Saves a name and answers the notice; a refused name says why and stores nothing, so the page can show it. */
	const save = async (write: () => Promise<void>): Promise<string> => {
		try {
			await write();
		} catch (error) {
			if (error instanceof NameError) {
				return error.message;
			}
			throw error;
		}
		return SAVED_NOTICE;
	};

	return {
		async view(): Promise<ModelsView> {
			const agents: ModelsView['agents'] = [];
			for (const adapter of adapters) {
				const entries = await modelsOf(adapter);
				agents.push({
					agentId: adapter.id,
					provider: { name: names.providerName(adapter.id, adapter.displayName), default: adapter.displayName },
					models: entries.map(entry => ({ value: entry.value, name: names.modelName(adapter.id, entry.value, entry.info.name), default: entry.info.name })),
				});
			}
			return { agents };
		},

		setProviderName: (agentId, name) => save(() => names.setProvider(agentId, name, defaultProviders())),

		async setModelName(agentId, model, name): Promise<string> {
			const adapter = adapters.find(item => item.id === agentId);
			if (!adapter) {
				return `There is no agent called ${agentId}.`;
			}
			const entries = await modelsOf(adapter);
			return save(() => names.setModel(agentId, model, name, entries.map(entry => ({ value: entry.value, name: entry.info.name }))));
		},

		async refresh(): Promise<string> {
			const refreshed: string[] = [];
			for (const adapter of adapters) {
				if (!await deps.usable(adapter)) {
					continue;
				}
				try {
					const fresh = await deps.source.refresh(adapter);
					if (fresh.length > 0) {
						refreshed.push(adapter.id);
					}
				} catch {
					// The saved list stands, and the adapter that failed is not named.
				}
			}
			return refreshed.length > 0 ? `Refreshed ${refreshed.join(', ')}.` : NOTHING_REFRESHED;
		},
	};
}
