/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_MIGRATION_MARKER, migrateSettingsOnce } from '../../src/core/settingsMigration';
import { FileConfig, configFileOf } from '../../src/hosts/http/config';
import { createFileStore } from '../../src/engine/store/fileStore';

const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-settings-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

const agents = [
	{ id: 'claude', settingKeys: ['idleTimeoutSeconds', 'toolSearch'] },
	{ id: 'codex', settingKeys: ['idleTimeoutSeconds'] },
];

/** What the user's own settings held for the released extension. */
function savedFrom(values: Record<string, unknown>): (section: string) => unknown {
	return section => values[section];
}

describe('the settings migration', () => {
	it('copies what the user saved into an empty config.json, switched-off agents included', async () => {
		const root = tempRoot();
		const store = createFileStore(root);
		const config = new FileConfig(configFileOf(root));

		const ran = await migrateSettingsOnce({
			saved: savedFrom({
				'agents.codex.enabled': false,
				'agents.claude.toolSearch': 'off',
				'agents.claude.idleTimeoutSeconds': 600,
				'resume.transcriptDetail': 'brief',
			}),
			config,
			agents,
			state: store.state,
			log: () => undefined,
		});

		expect(ran).toBe(true);
		const written = new FileConfig(configFileOf(root));
		expect(written.get('agents.codex.enabled')).toBe(false);
		expect(written.get('agents.claude.toolSearch')).toBe('off');
		expect(written.get('agents.claude.idleTimeoutSeconds')).toBe(600);
		expect(written.get('resume.transcriptDetail')).toBe('brief');
		expect(written.get('agents.codex.idleTimeoutSeconds')).toBeUndefined();
		expect(store.state.get(SETTINGS_MIGRATION_MARKER)).toBe(true);
	});

	it('keeps a value config.json already has, and ignores a setting the released extension never had', async () => {
		const root = tempRoot();
		const store = createFileStore(root);
		const config = new FileConfig(configFileOf(root));
		await config.set('agents.claude.toolSearch', 'on');

		await migrateSettingsOnce({
			saved: savedFrom({ 'agents.claude.toolSearch': 'off', 'agents.claude.maxChatSessions': 3, 'agents.google.command': 'agy' }),
			config,
			agents,
			state: store.state,
			log: () => undefined,
		});

		const written = new FileConfig(configFileOf(root));
		expect(written.get('agents.claude.toolSearch')).toBe('on');
		expect(written.get('agents.claude.maxChatSessions')).toBeUndefined();
		expect(written.get('agents.google.command')).toBeUndefined();
	});

	it('runs once: a later activation leaves a setting changed since alone', async () => {
		const root = tempRoot();
		const store = createFileStore(root);
		const config = new FileConfig(configFileOf(root));
		const saved = savedFrom({ 'agents.codex.enabled': false });
		const options = { saved, config, agents, state: store.state, log: () => undefined };

		await migrateSettingsOnce(options);
		await config.set('agents.codex.enabled', true);

		expect(await migrateSettingsOnce(options)).toBe(false);
		expect(new FileConfig(configFileOf(root)).get('agents.codex.enabled')).toBe(true);
	});

	it('leaves the marker unset when a write fails, so the next activation tries again', async () => {
		const root = tempRoot();
		const store = createFileStore(root);
		const lines: string[] = [];
		const failing = {
			get: () => undefined,
			set: async (): Promise<void> => { throw new Error('the disk is full'); },
		};

		await migrateSettingsOnce({
			saved: savedFrom({ 'agents.codex.enabled': false }),
			config: failing,
			agents,
			state: store.state,
			log: message => { lines.push(message); },
		});

		expect(store.state.get(SETTINGS_MIGRATION_MARKER)).toBeUndefined();
		expect(lines.join('\n')).toContain('the disk is full');
	});

	it('marks the migration done when the user saved nothing', async () => {
		const root = tempRoot();
		const store = createFileStore(root);

		await migrateSettingsOnce({ saved: () => undefined, config: new FileConfig(configFileOf(root)), agents, state: store.state, log: () => undefined });

		expect(store.state.get(SETTINGS_MIGRATION_MARKER)).toBe(true);
		expect(fs.existsSync(configFileOf(root))).toBe(false);
	});
});
