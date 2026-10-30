import type { AgentSettings } from '../core/adapter';

export function stringSetting(settings: AgentSettings, key: string, fallback = ''): string {
	const value = settings[key];
	return typeof value === 'string' ? value : fallback;
}

export function booleanSetting(settings: AgentSettings, key: string, fallback = false): boolean {
	const value = settings[key];
	return typeof value === 'boolean' ? value : fallback;
}

export function stringListSetting(settings: AgentSettings, key: string): string[] {
	const value = settings[key];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(item => typeof item === 'string');
}
