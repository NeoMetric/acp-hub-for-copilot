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

export function settingName(agentId: string, key: string): string {
	return `acpHub.agents.${agentId}.${key}`;
}

type JsonObject = Record<string, unknown>;

function propertyOf(spec: SettingSpec): JsonObject {
	const property: JsonObject = { description: spec.description, default: spec.default };

	if (spec.type === 'enum') {
		property.type = 'string';
		property.enum = spec.options ?? [];
		property.enumDescriptions = spec.optionDescriptions ?? [];
	} else if (spec.type === 'string-list') {
		property.type = 'array';
		property.items = { type: 'string' };
	} else if (spec.type === 'number') {
		property.type = 'number';
		property.minimum = 0;
	} else {
		property.type = spec.type;
	}
	return property;
}

/** One `acpHub.agents.<id>.<key>` entry for every setting of every agent, plus `enabled`. */
export function configurationOf(registry: RegistryFile): JsonObject {
	const properties: Record<string, JsonObject> = {};

	for (const agent of registry.agents) {
		properties[settingName(agent.id, 'enabled')] = {
			type: 'boolean',
			default: true,
			description: `Show ${agent.displayName} in the Copilot model picker.`,
		};
		for (const spec of [...registry.commonSettings, ...agent.settings]) {
			properties[settingName(agent.id, spec.key)] = propertyOf(spec);
		}
	}
	return { title: 'ACP Hub', properties };
}

export function activationEventsOf(registry: RegistryFile): string[] {
	return [
		'onStartupFinished',
		...registry.agents.map(agent => `onLanguageModelChatProvider:${vendorOf(agent.id)}`),
	];
}

/**
 * Returns a copy of package.json with the generated parts replaced: the
 * vendors, the activation events and the configuration.
 */
export function applyRegistry(packageJson: JsonObject, registry: RegistryFile): JsonObject {
	const contributes = { ...(packageJson.contributes as JsonObject) };
	contributes.languageModelChatProviders = registry.agents.map(agent => ({
		vendor: vendorOf(agent.id),
		displayName: agent.displayName,
	}));
	const existingConfiguration = contributes.configuration as { properties?: Record<string, JsonObject> } | undefined;
	const existingProperties = Object.fromEntries(
		Object.entries(existingConfiguration?.properties ?? {}).filter(([key]) => !key.startsWith('acpHub.agents.')),
	);
	const generatedConfiguration = configurationOf(registry);
	contributes.configuration = {
		...generatedConfiguration,
		properties: { ...existingProperties, ...(generatedConfiguration.properties as Record<string, JsonObject>) },
	};

	return {
		...packageJson,
		activationEvents: activationEventsOf(registry),
		contributes,
	};
}
