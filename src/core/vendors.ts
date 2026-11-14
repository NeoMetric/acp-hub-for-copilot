import type { SettingSpec } from './adapter';
import type { ManifestEntry } from '../adapters/generic';

export interface RegistryAgent {
	id: string;
	displayName: string;
	settings: SettingSpec[];
	install?: ManifestEntry['install'];
	launch?: ManifestEntry['launch'];
	auth?: ManifestEntry['auth'];
}

export interface RegistryFile {
	commonSettings: SettingSpec[];
	agents: RegistryAgent[];
}

/**
 * The Agents window does not load this extension's manifest, so it labels a
 * vendor by capitalising its id. A readable id keeps that label readable.
 */
export function vendorOf(agentId: string): string {
	return `${agentId.charAt(0).toUpperCase()}${agentId.slice(1)} Agent`;
}

type JsonObject = Record<string, unknown>;

/** The prefix of the settings a previous version generated for each agent. */
const AGENT_SETTING_PREFIX = 'acpHub.agents.';

export function activationEventsOf(registry: RegistryFile): string[] {
	return [
		'onStartupFinished',
		...registry.agents.map(agent => `onLanguageModelChatProvider:${vendorOf(agent.id)}`),
	];
}

/**
 * Returns a copy of package.json with the generated parts replaced: the
 * vendors and the activation events. An agent's settings are no longer
 * contributed — the sidebar and the store's `config.json` hold them — so the
 * ones a previous version generated are dropped, and every setting the
 * extension itself declares stays as it is. A setting it declares as
 * deprecated carries a `deprecationMessage`, so it is hand-written and stays
 * while everything generated goes.
 */
export function applyRegistry(packageJson: JsonObject, registry: RegistryFile): JsonObject {
	const contributes = { ...(packageJson.contributes as JsonObject) };
	contributes.languageModelChatProviders = registry.agents.map(agent => ({
		vendor: vendorOf(agent.id),
		displayName: agent.displayName,
	}));
	const configuration = contributes.configuration as { properties?: Record<string, JsonObject> } | undefined;
	if (configuration?.properties) {
		contributes.configuration = {
			...configuration,
			properties: Object.fromEntries(
				Object.entries(configuration.properties).filter(([key, value]) => !key.startsWith(AGENT_SETTING_PREFIX) || typeof value.deprecationMessage === 'string'),
			),
		};
	}

	return {
		...packageJson,
		activationEvents: activationEventsOf(registry),
		contributes,
	};
}
