/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from '../../../src/engine/store/fileStore';
import { storageRoot } from '../../../src/engine/store/paths';

const roots: string[] = [];

/** A store root of its own for one test, removed afterwards. */
function storeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-store-'));
	roots.push(root);
	return root;
}

/** The document a store file holds, as another process would read it. */
function documentAt(root: string, file = 'state.json'): { revision: number; values: Record<string, unknown> } {
	return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as { revision: number; values: Record<string, unknown> };
}

/** Leaves a lock behind, as a writer that died mid-write would. */
function leaveLock(root: string, record: unknown, file = 'state.json'): void {
	fs.writeFileSync(path.join(root, `${file}.lock`), JSON.stringify(record));
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('the file store', () => {
	it('round-trips the state a gateway wrote', async () => {
		const root = storeRoot();
		const store = createFileStore(root);

		expect(store.state.get('missing')).toBeUndefined();
		expect(store.state.keys()).toEqual([]);

		await store.state.update('acpHub.savedSessions.mock', { sessionId: 'session-1' });
		await store.state.update('signedIn.mock', true);

		expect(store.state.get('acpHub.savedSessions.mock')).toEqual({ sessionId: 'session-1' });
		expect(store.state.get<boolean>('signedIn.mock')).toBe(true);
		expect([...store.state.keys()].sort()).toEqual(['acpHub.savedSessions.mock', 'signedIn.mock']);
		expect(documentAt(root)).toEqual({
			revision: 2,
			values: { 'acpHub.savedSessions.mock': { sessionId: 'session-1' }, 'signedIn.mock': true },
		});

		const reopened = createFileStore(root);
		expect(reopened.state.get('signedIn.mock')).toBe(true);
	});

	it('retries a rename that a reader of the file holds up', async () => {
		const root = storeRoot();
		const store = createFileStore(root);
		const rename = fs.promises.rename.bind(fs.promises);
		let blocked = 2;
		const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
			if (blocked-- > 0) {
				throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
			}
			await rename(from, to);
		});

		try {
			await store.state.update('key', 1);
			expect(spy).toHaveBeenCalledTimes(3);
		} finally {
			spy.mockRestore();
		}

		expect(documentAt(root).values).toEqual({ key: 1 });
		expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
	});

	it('gives up on a rename that keeps failing, and leaves no temp file', async () => {
		const root = storeRoot();
		const store = createFileStore(root);
		const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }));

		try {
			await expect(store.state.update('key', 1)).rejects.toThrow('EPERM');
		} finally {
			spy.mockRestore();
		}

		expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
	});

	it('keeps what one gateway wrote when the other writes after it', async () => {
		const root = storeRoot();
		const first = createFileStore(root).state;
		const second = createFileStore(root).state;

		await first.update('first', 1);
		await second.update('second', 2);
		// `first` still holds its own older view of the file; its next write has to merge on top of `second`'s.
		await first.update('third', 3);

		expect(documentAt(root)).toEqual({ revision: 3, values: { first: 1, second: 2, third: 3 } });
		expect(first.get('second')).toBe(2);
		expect(second.get('third')).toBe(3);
	});

	it('keeps every write when two writers write at the same time', async () => {
		const root = storeRoot();
		const first = createFileStore(root).state;
		const second = createFileStore(root).state;

		await Promise.all([
			...Array.from({ length: 5 }, (_, index) => first.update(`first-${index}`, index)),
			...Array.from({ length: 5 }, (_, index) => second.update(`second-${index}`, index)),
		]);

		const document = documentAt(root);
		expect(Object.keys(document.values).sort()).toEqual([
			'first-0', 'first-1', 'first-2', 'first-3', 'first-4',
			'second-0', 'second-1', 'second-2', 'second-3', 'second-4',
		]);
		expect(document.revision).toBe(10);
	});

	it('keeps the agents keys in a file of their own', async () => {
		const root = storeRoot();
		const store = createFileStore(root);

		await store.secrets.set('mock', 'sk-test');
		expect(await createFileStore(root).secrets.get('mock')).toBe('sk-test');
		expect(documentAt(root, 'secrets.json').values).toEqual({ 'acpHub.apiKey.mock': 'sk-test' });

		await store.secrets.delete('mock');
		expect(await store.secrets.get('mock')).toBeUndefined();
	});

	it.skipIf(process.platform === 'win32')('writes the secrets where only their owner can read them', async () => {
		const root = storeRoot();

		await createFileStore(root).secrets.set('mock', 'sk-test');

		expect(fs.statSync(path.join(root, 'secrets.json')).mode & 0o777).toBe(0o600);
	});

	it('takes over a lock whose owner is gone', async () => {
		const root = storeRoot();
		const store = createFileStore(root).state;
		await store.update('kept', true);

		const dead = spawnSync(process.execPath, ['-e', '']);
		expect(dead.pid, 'the probe process has an id').toBeGreaterThan(0);
		leaveLock(root, { pid: dead.pid, at: Date.now(), token: 'dead' });

		await store.update('after-dead', true);

		expect(documentAt(root).values).toEqual({ kept: true, 'after-dead': true });
		expect(fs.existsSync(path.join(root, 'state.json.lock'))).toBe(false);
	});

	it('takes over a lock older than any write takes', async () => {
		const root = storeRoot();
		const store = createFileStore(root).state;

		leaveLock(root, { pid: process.pid, at: Date.now() - 60_000, token: 'old' });
		await store.update('after-old', true);

		expect(documentAt(root).values).toEqual({ 'after-old': true });
		expect(fs.existsSync(path.join(root, 'state.json.lock'))).toBe(false);
	});

	it('reports a corrupt state file and leaves it alone', async () => {
		const root = storeRoot();
		const file = path.join(root, 'state.json');
		fs.writeFileSync(file, '{ not json');
		const store = createFileStore(root);

		expect(() => store.state.get('anything')).toThrow(/state\.json/);
		await expect(store.state.update('anything', 1)).rejects.toThrow(/state\.json/);
		expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
	});

	it('reports a file that is not a store document and leaves it alone', async () => {
		const root = storeRoot();
		const file = path.join(root, 'secrets.json');
		fs.writeFileSync(file, '{ "revision": 1 }');
		const store = createFileStore(root);

		await expect(store.secrets.get('mock')).rejects.toThrow(/secrets\.json/);
		await expect(store.secrets.set('mock', 'sk-test')).rejects.toThrow(/secrets\.json/);
		expect(fs.readFileSync(file, 'utf8')).toBe('{ "revision": 1 }');
	});
});

describe('the storage root', () => {
	it('honours ACP_HUB_HOME', () => {
		expect(storageRoot({ ACP_HUB_HOME: 'custom-store' })).toBe(path.resolve('custom-store'));
	});

	it('falls back to the home folder', () => {
		expect(storageRoot({})).toBe(path.join(os.homedir(), '.acp-hub'));
	});
});
