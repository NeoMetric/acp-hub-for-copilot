/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { SECRETS_MIGRATION_MARKER, migrateSecretsOnce } from '../../src/core/secretsMigration';
import { createFileStore } from '../../src/engine/store/fileStore';
import { FakeSecretStorage } from './secrets';

const roots: string[] = [];

/** A folder of its own for one test, removed afterwards. */
function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-secrets-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

/** Secret storage the window cannot read, as a locked keychain would leave it. */
function unreadableSecretStorage(): vscode.SecretStorage {
	return {
		onDidChange: () => ({ dispose() { /* Nothing listens. */ } }),
		get: async () => { throw new Error('the keychain is locked'); },
		store: async () => { throw new Error('the keychain is locked'); },
		delete: async () => { throw new Error('the keychain is locked'); },
	} as unknown as vscode.SecretStorage;
}

/** A log that keeps what it was told, so the test sees what the migration reported. */
function recordingLog(): { lines: string[]; log: (message: string, level?: string) => void } {
	const lines: string[] = [];
	return { lines, log: (message: string) => { lines.push(message); } };
}

describe('the API key migration', () => {
	it('copies a key the released extension saved into an empty store', async () => {
		const root = tempRoot();
		const legacy = new FakeSecretStorage();
		await legacy.store('acpHub.apiKey.claude', 'claude-key-saved-by-0.0.4');
		const store = createFileStore(root);
		const logged = recordingLog();

		expect(await migrateSecretsOnce({
			secrets: legacy.asSecretStorage(),
			target: store.secrets,
			agentIds: ['claude', 'codex'],
			state: store.state,
			log: logged.log,
		})).toBe(true);

		// The server reads the key from the shared store, so it survives the upgrade.
		expect(await createFileStore(root).secrets.get('claude')).toBe('claude-key-saved-by-0.0.4');
		// An agent who never saved one gets nothing written for it.
		expect(await createFileStore(root).secrets.get('codex')).toBeUndefined();
		expect(createFileStore(root).state.get<boolean>(SECRETS_MIGRATION_MARKER)).toBe(true);
		// The secret itself never reaches the output channel.
		expect(logged.lines.join('\n')).not.toContain('claude-key-saved-by-0.0.4');
	});

	it('never overwrites a key the shared store already has', async () => {
		const root = tempRoot();
		const legacy = new FakeSecretStorage();
		await legacy.store('acpHub.apiKey.claude', 'an-older-key');
		await legacy.store('acpHub.apiKey.codex', 'a-key-only-the-mirror-has');
		const store = createFileStore(root);
		await store.secrets.set('claude', 'the-newer-key');

		await migrateSecretsOnce({
			secrets: legacy.asSecretStorage(),
			target: store.secrets,
			agentIds: ['claude', 'codex'],
			state: store.state,
			log: () => undefined,
		});

		expect(await store.secrets.get('claude')).toBe('the-newer-key');
		// An agent the store has no key for still gets the one the mirror holds.
		expect(await store.secrets.get('codex')).toBe('a-key-only-the-mirror-has');
	});

	it('reads only the agents it is given, so no id is baked in', async () => {
		const root = tempRoot();
		const legacy = new FakeSecretStorage();
		await legacy.store('acpHub.apiKey.claude', 'claude-key');
		await legacy.store('acpHub.apiKey.google', 'google-key');
		const store = createFileStore(root);

		await migrateSecretsOnce({
			secrets: legacy.asSecretStorage(),
			target: store.secrets,
			agentIds: ['google'],
			state: store.state,
			log: () => undefined,
		});

		expect(await store.secrets.get('google')).toBe('google-key');
		expect(await store.secrets.get('claude')).toBeUndefined();
	});

	it('is a no-op on the next call, even for a key the mirror gained after it', async () => {
		const root = tempRoot();
		const legacy = new FakeSecretStorage();
		await legacy.store('acpHub.apiKey.claude', 'claude-key');
		const store = createFileStore(root);
		const options = {
			secrets: legacy.asSecretStorage(),
			target: store.secrets,
			agentIds: ['claude', 'codex'],
			state: store.state,
			log: () => undefined,
		};
		await migrateSecretsOnce(options);
		await legacy.store('acpHub.apiKey.codex', 'a-key-saved-later');

		expect(await migrateSecretsOnce({ ...options, state: createFileStore(root).state })).toBe(false);

		expect(await store.secrets.get('codex')).toBeUndefined();
	});

	it('keeps activating when the window refuses its secrets, and retries the next time', async () => {
		const root = tempRoot();
		const store = createFileStore(root);
		const logged = recordingLog();

		await expect(migrateSecretsOnce({
			secrets: unreadableSecretStorage(),
			target: store.secrets,
			agentIds: ['claude', 'codex'],
			state: store.state,
			log: logged.log,
		})).resolves.toBe(true);

		// The marker stays unset, so an activation whose keychain was locked tries again.
		expect(createFileStore(root).state.get<boolean>(SECRETS_MIGRATION_MARKER)).toBeUndefined();
		expect(logged.lines).toHaveLength(2);
	});
});
