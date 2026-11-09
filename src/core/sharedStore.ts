/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StateStore } from '../engine/ports/state';
import { createFileStore, type FileStore } from '../engine/store/fileStore';
import type { Log } from './logging';

/** The key that records the copy, so a later run leaves the store alone. */
export const MIGRATION_MARKER = 'acpHub.storeMigrated';

/** Everything the extension saved under `acpHub.`, and the sign-in flag of each agent. */
const MIGRATED_PREFIXES = ['acpHub.', 'signedIn.'] as const;
/** The one key the sidebar saved outside those prefixes. */
const MIGRATED_KEYS: readonly string[] = ['sidebar.visibleAgents'];

export interface SharedStore {
	readonly store: FileStore;
	/** The folder the store is in: the shared one, or the fallback when that could not be written. */
	readonly root: string;
}

/**
 * The store both gateways read and write, at the shared root. A root that
 * cannot be written — a read-only home folder, say — falls back to the
 * extension's own storage folder, with a warning, so the extension still works.
 */
export function openSharedStore(options: { root: string; fallbackRoot: string; log: Log }): SharedStore {
	try {
		return { store: openAt(options.root), root: path.resolve(options.root) };
	} catch (error) {
		options.log(`Could not keep the shared store in ${path.resolve(options.root)} (${messageOf(error)}); keeping it in ${path.resolve(options.fallbackRoot)} instead.`, 'warn');
		return { store: openAt(options.fallbackRoot), root: path.resolve(options.fallbackRoot) };
	}
}

/**
 * Opens the store at `root` once a probe file has proved the folder writable:
 * a read-only folder accepts the directory and only fails on the first write.
 */
function openAt(root: string): FileStore {
	const directory = path.resolve(root);
	const store = createFileStore(directory);
	const probe = path.join(directory, `.writable-${process.pid}.tmp`);
	fs.writeFileSync(probe, '');
	fs.rmSync(probe, { force: true });
	return store;
}

/**
 * Copies what the extension kept in its Memento into the store, once, under
 * {@link MIGRATION_MARKER}. The Memento keeps its values so a downgrade still
 * finds them; a key the store already has wins, since the other gateway may
 * have written it last.
 */
export async function migrateState(source: StateStore, target: StateStore): Promise<boolean> {
	if (target.get<boolean>(MIGRATION_MARKER) === true) {
		return false;
	}
	// Queued before the first await, so a reader of the store sees the values as soon as this returns.
	const copies: Promise<void>[] = [];
	for (const key of source.keys()) {
		if (!isMigratedKey(key) || target.get(key) !== undefined) {
			continue;
		}
		const value = source.get(key);
		if (value !== undefined) {
			copies.push(target.update(key, value));
		}
	}
	await Promise.all(copies);
	await target.update(MIGRATION_MARKER, true);
	return true;
}

function isMigratedKey(key: string): boolean {
	return key !== MIGRATION_MARKER
		&& (MIGRATED_PREFIXES.some(prefix => key.startsWith(prefix)) || MIGRATED_KEYS.includes(key));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
