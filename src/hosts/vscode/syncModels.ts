/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vendorOf } from '../../core/vendors';
import type { ModelNames } from '../../engine/models/modelNames';
import type { StateStore } from '../../engine/ports/state';
import { CLI_EFFORT_LEVELS, CLI_PROVIDERS_KEY, writeCliProviders, writeVendorNames, type CliProvider } from './applyNames';
import { listModels, refreshModels } from './serverClient';
import type { ServerEndpoint } from './serverLink';

/**
 * Pushes the models the server publishes into the two Copilot surfaces: the
 * model list the CLI reads from `~/.copilot/providers.json`, and the provider
 * headings this extension's `package.json` gives VS Code. The server stays
 * client-agnostic; only this window writes the files.
 */
export interface SyncModelsDeps {
	readonly endpoint: ServerEndpoint;
	/** Every agent, in registry order, with the name it is shown under when the user chose none. */
	readonly agents: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
	readonly names: ModelNames;
	/** Where the providers this window wrote are remembered, so a later sync replaces them. */
	readonly state: StateStore;
	readonly packageJson: string;
	readonly providersFile: string;
}

/** What one sync did, and what it could not do. */
export interface SyncOutcome {
	/** The agent ids that answered the refresh. */
	readonly refreshed: string[];
	/** How many providers, and how many models under them, reached `providers.json`. */
	readonly providers: number;
	readonly models: number;
	/** One line per target that failed, in the order they were tried. */
	readonly problems: string[];
	/** Whether the manifest changed, since only a change needs a window reload. */
	readonly reloadNeeded: boolean;
}

const NOTHING_OFFERED = 'No agent offered a model, so providers.json was left as it was.';

export async function syncModels(deps: SyncModelsDeps): Promise<SyncOutcome> {
	const problems: string[] = [];
	let refreshed: string[] = [];
	try {
		refreshed = await refreshModels(deps.endpoint);
	} catch (error) {
		// The saved list below is what the agents last answered, so a refused refresh is worth a line, not a stop.
		problems.push(`The agents' models could not be read again: ${messageOf(error)}`);
	}

	const wires = await listModels(deps.endpoint);
	const providers: CliProvider[] = [];
	for (const agent of deps.agents) {
		const models = wires.filter(wire => wire.owned_by === agent.id && wire.acp !== undefined);
		if (models.length > 0) {
			providers.push({
				name: deps.names.providerName(agent.id, agent.displayName),
				models: models.map(wire => ({ name: wire.acp!.name, wireModel: wire.id, efforts: cliEffortsOf(wire.acp!.efforts), maxInputTokens: wire.acp!.maxInputTokens, maxOutputTokens: wire.acp!.maxOutputTokens })),
			});
		}
	}

	if (providers.length === 0) {
		problems.push(NOTHING_OFFERED);
	} else {
		try {
			const { written } = writeCliProviders({
				file: deps.providersFile,
				baseUrl: `${deps.endpoint.baseUrl}/v1`,
				token: deps.endpoint.token,
				providers,
				previous: deps.state.get<string[]>(CLI_PROVIDERS_KEY) ?? [],
			});
			await deps.state.update(CLI_PROVIDERS_KEY, written);
		} catch (error) {
			problems.push(`Copilot CLI: ${messageOf(error)}`);
		}
	}

	let reloadNeeded = false;
	try {
		reloadNeeded = writeVendorNames({
			packageJson: deps.packageJson,
			names: Object.fromEntries(deps.agents.map(agent => [vendorOf(agent.id), deps.names.providerName(agent.id, agent.displayName)])),
		});
	} catch (error) {
		problems.push(`VS Code: could not update ${deps.packageJson}: ${messageOf(error)}`);
	}

	return {
		refreshed,
		// Counted from what the server published, so a refused file still tells the truth about the models.
		providers: providers.length,
		models: providers.reduce((total, provider) => total + provider.models.length, 0),
		problems,
		reloadNeeded,
	};
}

/** The levels the CLI knows, in its order; the server's own `default` and any level the CLI lacks are left out. */
function cliEffortsOf(efforts: ReadonlyArray<{ readonly value: string }>): string[] {
	const offered = new Set(efforts.map(effort => effort.value));
	return CLI_EFFORT_LEVELS.filter(level => offered.has(level));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
