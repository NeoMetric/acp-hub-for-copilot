import type { AgentAdapter, AgentSettings, SettingSpec } from './adapter';

/** The part of vscode.WorkspaceConfiguration that is read here. */
export interface ConfigReader {
	get<T>(section: string): T | undefined;
}

export interface ReadSettingsResult {
	values: AgentSettings;
	warnings: string[];
}

/** The key the setting is stored under, without the `acpHub.` prefix. */
export function settingKey(agentId: string, key: string): string {
	return `agents.${agentId}.${key}`;
}

function isValid(spec: SettingSpec, value: unknown): boolean {
	if (spec.type === 'string') {
		return typeof value === 'string';
	}
	if (spec.type === 'number') {
		return typeof value === 'number' && Number.isFinite(value) && value >= 0;
	}
	if (spec.type === 'boolean') {
		return typeof value === 'boolean';
	}
	return typeof value === 'string' && (spec.options ?? []).includes(value);
}

/**
 * Reads the settings of one agent from the `acpHub` configuration. A value of
 * the wrong type is replaced by the default and reported in `warnings`.
 */
export function readAgentSettings(adapter: AgentAdapter, config: ConfigReader): ReadSettingsResult {
	const values: AgentSettings = {};
	const warnings: string[] = [];

	for (const spec of adapter.settings) {
		const name = settingKey(adapter.id, spec.key);
		const value = config.get<unknown>(name);

		if (value === undefined || value === null) {
			values[spec.key] = spec.default;
			continue;
		}
		if (!isValid(spec, value)) {
			warnings.push(`Setting acpHub.${name} has an invalid value and was ignored; using ${String(spec.default)}.`);
			values[spec.key] = spec.default;
			continue;
		}
		values[spec.key] = value as string | number | boolean;
	}

	return { values, warnings };
}
