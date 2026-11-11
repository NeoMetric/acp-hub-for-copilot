/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { StateStore } from '../engine/ports/state';
import type { Log } from './logging';

/** The key that records the copy, so a later activation leaves the settings alone. */
export const SETTINGS_MIGRATION_MARKER = 'acpHub.settingsMigrated';

/** The transcript settings the released extension contributed, which apply to every agent. */
const RESUME_SECTIONS = ['resume.transcriptDetail', 'resume.transcriptMaxCharacters', 'resume.transcriptMaxToolResultCharacters'];

/** The settings file of the store, as far as the migration reads and writes it. */
export interface SettingsFile {
	get<T>(section: string): T | undefined;
	set(section: string, value: unknown): Promise<void>;
}

export interface MigrateSettingsOptions {
	/** What the user saved for `acpHub.<section>` in their own settings, or `undefined` when they saved nothing. */
	readonly saved: (section: string) => unknown;
	/** The store's `config.json`, where the server reads the settings from. */
	readonly config: SettingsFile;
	readonly agents: readonly { readonly id: string; readonly settingKeys: readonly string[] }[];
	readonly state: StateStore;
	readonly log: Log;
}

/**
 * Carries the settings the released extension read from the user's own settings
 * (`acpHub.agents.<id>.*` and `acpHub.resume.*`) into the store's `config.json`,
 * once, so an upgrade does not reset them: an agent the user switched off stays
 * off instead of starting with the window. A value `config.json` already has
 * wins, since the server may have written it last, and a setting the released
 * extension never had is left alone. A failure leaves the marker unset, so the
 * next activation tries again, and never reaches the caller.
 */
export async function migrateSettingsOnce(options: MigrateSettingsOptions): Promise<boolean> {
	if (options.state.get<boolean>(SETTINGS_MIGRATION_MARKER) === true) {
		return false;
	}
	const sections = [
		...options.agents.flatMap(agent => ['enabled', ...agent.settingKeys].map(key => `agents.${agent.id}.${key}`)),
		...RESUME_SECTIONS,
	];
	let copied = 0;
	let failed = 0;
	for (const section of sections) {
		try {
			const value = options.saved(section);
			if (value === undefined || value === null || options.config.get(section) !== undefined) {
				continue;
			}
			await options.config.set(section, value);
			copied += 1;
		} catch (error) {
			failed += 1;
			options.log(`Could not carry the setting acpHub.${section} into the shared store: ${messageOf(error)}`, 'warn');
		}
	}
	if (failed > 0) {
		return true;
	}
	if (copied > 0) {
		options.log(`Carried ${copied} ${copied === 1 ? 'setting' : 'settings'} of the previous version into the shared store.`);
	}
	await options.state.update(SETTINGS_MIGRATION_MARKER, true);
	return true;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
