/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { SecretStore, StateStore } from '../engine/ports/state';
import type { Log } from './logging';

/** The key that records the copy, so a later activation leaves the window's secrets alone. */
export const SECRETS_MIGRATION_MARKER = 'acpHub.secretsMigrated';

/** The name the extension filed an agent's key under while the window held the only copy. */
function secretName(agentId: string): string {
	return `acpHub.apiKey.${agentId}`;
}

export interface MigrateSecretsOptions {
	/** The window's secret storage, whose keys the released extension wrote and nothing else reads now. */
	readonly secrets: Pick<vscode.SecretStorage, 'get'>;
	/** The store the server reads the keys from. */
	readonly target: SecretStore;
	readonly agentIds: readonly string[];
	readonly state: StateStore;
	readonly log: Log;
}

/**
 * Carries the API keys the released extension kept in the window's secret
 * storage into the shared store, once, so an upgrade does not make a saved key
 * look missing. A key the store already holds wins, since the server may have
 * written it last; an agent who saved none is left alone. A key storage that
 * cannot be read leaves the marker unset, so the next activation tries again,
 * and no failure ever reaches the caller: an upgrade that loses a key is still
 * a window that starts.
 */
export async function migrateSecretsOnce(options: MigrateSecretsOptions): Promise<boolean> {
	if (options.state.get<boolean>(SECRETS_MIGRATION_MARKER) === true) {
		return false;
	}
	let copied = 0;
	let failed = 0;
	for (const id of options.agentIds) {
		try {
			const saved = await options.secrets.get(secretName(id));
			if (!saved || await options.target.get(id) !== undefined) {
				continue;
			}
			await options.target.set(id, saved);
			copied += 1;
		} catch (error) {
			failed += 1;
			options.log(`Could not carry the saved API key of ${id} into the shared store: ${messageOf(error)}`, 'warn');
		}
	}
	if (failed > 0) {
		return true;
	}
	if (copied > 0) {
		options.log(`Carried the saved API keys of ${copied} ${copied === 1 ? 'agent' : 'agents'} into the shared store.`);
	}
	await options.state.update(SECRETS_MIGRATION_MARKER, true);
	return true;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
