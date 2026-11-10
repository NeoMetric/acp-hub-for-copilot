/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter } from '../../core/adapter';
import type { ModelEntry } from '../../core/modelInfo';
import { vendorOf } from '../../core/vendors';
import { NameError, type ModelNames } from '../../engine/models/modelNames';
import type { StateStore } from '../../engine/ports/state';
import type { ModelsSurface, ModelsView } from '../../ui/messages';
import { writeCliProviders, writeVendorNames, type CliProvider } from './applyNames';

/** The state key that remembers which providers were last written to the CLI's `providers.json`. */
const CLI_PROVIDERS_KEY = 'server.cliProviders';

const RELOAD_NOTICE = 'Reload the VS Code window and restart the Copilot CLI for the changes to take effect.';

export interface ModelsSurfaceDeps {
	readonly adapters: readonly AgentAdapter[];
	/** Whether the agent is enabled and on this machine, which is what decides that it is offered. */
	usable(adapter: AgentAdapter): Promise<boolean>;
	readonly names: ModelNames;
	readonly state: StateStore;
	readonly source: {
		/** The models saved for the agent; reading them never starts it. */
		savedOf(agentId: string): ModelEntry[];
		/** A lookup now, which may start the agent. */
		refresh(adapter: AgentAdapter): Promise<ModelEntry[]>;
	};
	/** The token written into the CLI's file; it is never put in a notice. */
	readonly token: string | undefined;
	readonly baseUrl: () => string;
	/** The Copilot CLI's `providers.json`. */
	readonly providersFile: string;
	/** The extension's `package.json`, whose vendor display names VS Code shows. */
	readonly packageJson: string;
}

export function createModelsSurface(deps: ModelsSurfaceDeps): ModelsSurface {
	const { adapters, names } = deps;

	/** The agent's models as saved, or none when it is not offered; only a refresh asks the agent, and a failed one keeps the saved list. */
	const modelsOf = async (adapter: AgentAdapter, refresh = false): Promise<ModelEntry[]> => {
		if (!await deps.usable(adapter)) {
			return [];
		}
		if (refresh) {
			try {
				const fresh = await deps.source.refresh(adapter);
				if (fresh.length > 0) {
					return fresh;
				}
			} catch {
				// The saved list below is what is offered when the agent cannot answer.
			}
		}
		return deps.source.savedOf(adapter.id);
	};

	const defaultProviders = (): Map<string, string> => new Map(adapters.map(adapter => [adapter.id, adapter.displayName]));

	/** Writes the names to both targets; a failure of one is reported and does not stop the other. */
	const apply = async (): Promise<string> => {
		const problems: string[] = [];

		const providers: CliProvider[] = [];
		for (const adapter of adapters) {
			const entries = await modelsOf(adapter);
			if (entries.length > 0) {
				providers.push({
					name: names.providerName(adapter.id, adapter.displayName),
					models: entries.map(entry => ({ name: names.modelName(adapter.id, entry.value, entry.info.name), wireModel: `${adapter.id}/${entry.value}` })),
				});
			}
		}
		try {
			const { written } = writeCliProviders({
				file: deps.providersFile,
				baseUrl: deps.baseUrl(),
				token: deps.token,
				providers,
				previous: deps.state.get<string[]>(CLI_PROVIDERS_KEY) ?? [],
			});
			await deps.state.update(CLI_PROVIDERS_KEY, written);
		} catch (error) {
			problems.push(`Copilot CLI: ${messageOf(error)}`);
		}

		try {
			writeVendorNames({
				packageJson: deps.packageJson,
				names: Object.fromEntries(adapters.map(adapter => [vendorOf(adapter.id), names.providerName(adapter.id, adapter.displayName)])),
			});
		} catch (error) {
			problems.push(`VS Code: could not update ${deps.packageJson}: ${messageOf(error)}`);
		}

		return [...problems, RELOAD_NOTICE].join('\n');
	};

	/** Runs one change to the names, then applies; a refused name is the notice and nothing is written. */
	const change = async (save: () => Promise<void>): Promise<string> => {
		try {
			await save();
		} catch (error) {
			if (error instanceof NameError) {
				return error.message;
			}
			throw error;
		}
		return apply();
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

		setProviderName: (agentId, name) => change(() => names.setProvider(agentId, name, defaultProviders())),

		async setModelName(agentId, model, name): Promise<string> {
			const adapter = adapters.find(item => item.id === agentId);
			if (!adapter) {
				return `There is no agent called ${agentId}.`;
			}
			const entries = await modelsOf(adapter);
			return change(() => names.setModel(agentId, model, name, entries.map(entry => ({ value: entry.value, name: entry.info.name }))));
		},

		async sync(): Promise<string> {
			for (const adapter of adapters) {
				await modelsOf(adapter, true);
			}
			return apply();
		},
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
