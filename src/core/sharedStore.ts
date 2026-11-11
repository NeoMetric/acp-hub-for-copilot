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

/** The key that records the move of the installs, so a later activation leaves the old folders alone. */
export const INSTALLS_MIGRATION_MARKER = 'acpHub.installsMigrated';

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

/**
 * Moves the agents an older version installed under its own storage folder —
 * `<sourceRoot>/<agentId>` — into the shared root both gateways read, so an
 * upgrade does not make every installed agent look missing. An agent the
 * shared root already has is skipped, and a source only leaves once its
 * contents are in place.
 */
export async function migrateInstalls(
	sourceRoot: string,
	agentsRoot: string,
	agentIds: readonly string[],
	log: Log,
): Promise<void> {
	const source = path.resolve(sourceRoot);
	const target = path.resolve(agentsRoot);
	// The shared root fell back to the extension's own folder: the installs are already where they belong.
	if (source === path.dirname(target)) {
		return;
	}
	let moved = 0;
	let failed = 0;
	let firstError: unknown;
	for (const id of agentIds) {
		const from = path.join(source, id);
		const to = path.join(target, id);
		if (fs.existsSync(to) || !fs.existsSync(from)) {
			continue;
		}
		try {
			moveDirectory(from, to);
			moved += 1;
			log(`Moved ${id} from ${from} to ${to}.`);
		} catch (error) {
			failed += 1;
			firstError ??= error;
			log(`Could not move ${from} to ${to}: ${messageOf(error)}`, 'warn');
		}
	}
	log(`Moved ${moved} of ${agentIds.length} agent installs into ${target}.${failed > 0 ? ` ${failed} kept where they were.` : ''}`);
	// A failed move leaves the marker unset, so the next activation tries the agents still in the old folder again.
	if (firstError !== undefined) {
		throw firstError instanceof Error ? firstError : new Error(String(firstError));
	}
}

/**
 * Runs {@link migrateInstalls} once: the marker lands only after the loop, so
 * an activation whose move failed retries it, and one that finished never
 * looks at the old folder again.
 */
export async function migrateInstallsOnce(options: {
	sourceRoot: string;
	agentsRoot: string;
	agentIds: readonly string[];
	state: StateStore;
	log: Log;
}): Promise<boolean> {
	if (options.state.get<boolean>(INSTALLS_MIGRATION_MARKER) === true) {
		return false;
	}
	await migrateInstalls(options.sourceRoot, options.agentsRoot, options.agentIds, options.log);
	await options.state.update(INSTALLS_MIGRATION_MARKER, true);
	return true;
}

/** A rename across volumes fails with `EXDEV`; the copy is the fallback, and its source goes once the copy is complete. */
function moveDirectory(from: string, to: string): void {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	try {
		fs.renameSync(from, to);
	} catch (error) {
		if (!isCrossDevice(error)) {
			throw error;
		}
		try {
			fs.cpSync(from, to, { recursive: true });
		} catch (copyError) {
			// A half copy would hide the install from the next attempt, so it goes.
			fs.rmSync(to, { recursive: true, force: true });
			throw copyError;
		}
		fs.rmSync(from, { recursive: true, force: true });
	}
}

function isCrossDevice(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === 'EXDEV';
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
