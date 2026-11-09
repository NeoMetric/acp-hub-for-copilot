/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATION_MARKER, migrateState, openSharedStore } from '../../src/core/sharedStore';
import { createFileStore } from '../../src/engine/store/fileStore';
import type { StateStore } from '../../src/engine/ports/state';

const roots: string[] = [];

/** A folder of its own for one test, removed afterwards. */
function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-migration-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/**
 * The Memento the extension kept its state in, as `stateStoreOf` hands it to
 * the store: the values are read once, and the Memento keeps them afterwards.
 */
function fakeMemento(values: Record<string, unknown>): StateStore {
	const entries = new Map(Object.entries(values));
	return {
		get: <T>(key: string) => entries.get(key) as T | undefined,
		update: async (key, value) => { entries.set(key, value); },
		keys: () => [...entries.keys()],
	};
}

/** The store with its writes recorded, so a migration that changes nothing is visible as one. */
function counting(store: StateStore): { state: StateStore; writes: string[] } {
	const writes: string[] = [];
	return {
		writes,
		state: {
			get: <T>(key: string) => store.get<T>(key),
			keys: () => store.keys(),
			update: (key, value) => { writes.push(key); return store.update(key, value); },
		},
	};
}

describe('the state migration', () => {
	it('copies the Memento keys into the store under the marker', async () => {
		const root = tempRoot();
		const memento = fakeMemento({
			'acpHub.models.claude': ['claude-opus'],
			'signedIn.claude': true,
			'sidebar.visibleAgents': ['claude'],
		});

		expect(await migrateState(memento, createFileStore(root).state)).toBe(true);

		const store = createFileStore(root).state;
		expect(store.get('acpHub.models.claude')).toEqual(['claude-opus']);
		expect(store.get<boolean>('signedIn.claude')).toBe(true);
		expect(store.get('sidebar.visibleAgents')).toEqual(['claude']);
		expect(store.get<boolean>(MIGRATION_MARKER)).toBe(true);
		// The Memento keeps its values, so a downgrade still finds what it wrote.
		expect(memento.get<boolean>('signedIn.claude')).toBe(true);
		expect([...memento.keys()].sort()).toEqual(['acpHub.models.claude', 'sidebar.visibleAgents', 'signedIn.claude']);
	});

	it('is a no-op on the next run', async () => {
		const root = tempRoot();
		const memento = fakeMemento({
			'acpHub.models.claude': ['claude-opus'],
			'signedIn.claude': true,
			'sidebar.visibleAgents': ['claude'],
		});
		const store = counting(createFileStore(root).state);
		await migrateState(memento, store.state);
		store.writes.length = 0;

		expect(await migrateState(memento, store.state)).toBe(false);

		expect(store.writes).toEqual([]);
		// The next activation builds a new store; the marker on disk has to stop it.
		expect(createFileStore(root).state.get<boolean>(MIGRATION_MARKER)).toBe(true);
	});

	it('never overwrites a key the store already has', async () => {
		const store = createFileStore(tempRoot()).state;
		await store.update('signedIn.claude', false);
		await store.update('acpHub.savedSessions.claude', ['from the gateway']);

		await migrateState(fakeMemento({
			'signedIn.claude': true,
			'acpHub.savedSessions.claude': ['from the extension'],
			'acpHub.models.claude': ['claude-opus'],
			'not the extension\'s': 'left behind',
		}), store);

		expect(store.get<boolean>('signedIn.claude')).toBe(false);
		expect(store.get('acpHub.savedSessions.claude')).toEqual(['from the gateway']);
		// A key the store lacks is still taken over.
		expect(store.get('acpHub.models.claude')).toEqual(['claude-opus']);
		expect(store.get('not the extension\'s')).toBeUndefined();
	});
});

describe('the shared store', () => {
	it('opens the store at the shared root', async () => {
		const root = tempRoot();
		const warned: string[] = [];

		const opened = openSharedStore({ root, fallbackRoot: path.join(root, 'global-storage'), log: (message, level) => { if (level === 'warn') { warned.push(message); } } });

		expect(opened.root).toBe(path.resolve(root));
		expect(warned).toEqual([]);
		await opened.store.state.update('kept', true);
		expect(createFileStore(root).state.get('kept')).toBe(true);
	});

	it('falls back to the global storage folder when the shared root cannot be created', async () => {
		const root = tempRoot();
		const blocked = path.join(root, 'not-a-folder');
		fs.writeFileSync(blocked, 'a file stands where the folder would be');
		const fallback = path.join(root, 'global-storage');
		const warned: string[] = [];
		const log = (message: string, level?: string): void => { if (level === 'warn') { warned.push(message); } };

		const opened = openSharedStore({ root: path.join(blocked, 'store'), fallbackRoot: fallback, log });

		expect(opened.root).toBe(path.resolve(fallback));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(path.join(blocked, 'store'));
		await opened.store.state.update('kept', true);
		expect(createFileStore(fallback).state.get('kept')).toBe(true);
	});

	const isRoot = process.getuid?.() === 0;
	it.skipIf(process.platform === 'win32' || isRoot)('falls back when the shared root is read-only', () => {
		const root = tempRoot();
		const readOnly = path.join(root, 'read-only');
		fs.mkdirSync(readOnly);
		fs.chmodSync(readOnly, 0o500);
		const fallback = path.join(root, 'global-storage');
		const warned: string[] = [];

		const opened = openSharedStore({ root: readOnly, fallbackRoot: fallback, log: (message, level) => { if (level === 'warn') { warned.push(message); } } });

		expect(opened.root).toBe(path.resolve(fallback));
		expect(warned).toHaveLength(1);
	});
});
