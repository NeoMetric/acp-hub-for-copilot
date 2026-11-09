/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Log } from '../../src/core/logging';
import { INSTALLS_MIGRATION_MARKER, migrateInstalls, migrateInstallsOnce } from '../../src/core/sharedStore';
import { createFileStore } from '../../src/engine/store/fileStore';

/** The failures a move cannot provoke on one volume: a rename across volumes, and a copy that gives up. */
const fsControl = vi.hoisted(() => ({ crossDevice: false, copyFails: false }));

vi.mock('node:fs', async importOriginal => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		renameSync: (from: fs.PathLike, to: fs.PathLike) => {
			if (fsControl.crossDevice) {
				throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
			}
			actual.renameSync(from, to);
		},
		cpSync: (from: string | URL, to: string | URL, options?: fs.CopySyncOptions) => {
			if (fsControl.copyFails) {
				// What a copy that ran out of room leaves behind: a folder with some of the files.
				actual.mkdirSync(to, { recursive: true });
				throw new Error('no space left on device');
			}
			actual.cpSync(from, to, options);
		},
	};
});

const roots: string[] = [];

/** A folder of its own for one test, removed afterwards. */
function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-installs-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	fsControl.crossDevice = false;
	fsControl.copyFails = false;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

/** An install folder as the installers leave it: an entry file, the pid registry and a log. */
function writeInstall(dir: string, text: string): void {
	fs.mkdirSync(path.join(dir, 'agents', 'logs'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'entry.js'), text);
	fs.writeFileSync(path.join(dir, 'agents', 'pids.json'), text);
	fs.writeFileSync(path.join(dir, 'agents', 'logs', 'last.log'), text);
}

function readInstall(dir: string): { entry: string; pids: string; log: string } {
	return {
		entry: fs.readFileSync(path.join(dir, 'entry.js'), 'utf8'),
		pids: fs.readFileSync(path.join(dir, 'agents', 'pids.json'), 'utf8'),
		log: fs.readFileSync(path.join(dir, 'agents', 'logs', 'last.log'), 'utf8'),
	};
}

/** A log that keeps what it was told, so the test sees what the move reported. */
function recordingLog(): { lines: string[]; log: Log } {
	const lines: string[] = [];
	return { lines, log: (message: string) => { lines.push(message); } };
}

describe('the install migration', () => {
	it('moves an agent folder with everything in it', async () => {
		const root = tempRoot();
		const source = path.join(root, 'global-storage');
		const agents = path.join(root, 'acp-hub', 'agents');
		writeInstall(path.join(source, 'claude'), 'claude');
		const { lines, log } = recordingLog();

		await migrateInstalls(source, agents, ['claude', 'codex'], log);

		expect(readInstall(path.join(agents, 'claude'))).toEqual({ entry: 'claude', pids: 'claude', log: 'claude' });
		expect(fs.existsSync(path.join(source, 'claude'))).toBe(false);
		// One line for the agent that moved and one summary; codex had nothing to move.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('claude');
		expect(lines[1]).toContain('1 of 2');
		expect(lines[1]).toContain(path.join(agents));
	});

	it('keeps an agent the shared root already has, and the old folder stays', async () => {
		const root = tempRoot();
		const source = path.join(root, 'global-storage');
		const agents = path.join(root, 'acp-hub', 'agents');
		writeInstall(path.join(source, 'claude'), 'old');
		writeInstall(path.join(agents, 'claude'), 'new');

		await migrateInstalls(source, agents, ['claude'], () => { });

		expect(readInstall(path.join(agents, 'claude')).entry).toBe('new');
		// The source is not deleted: nothing proved the install there is a copy of the one kept.
		expect(readInstall(path.join(source, 'claude')).entry).toBe('old');
	});

	it('does nothing on a machine that never installed an agent', async () => {
		const root = tempRoot();
		const source = path.join(root, 'global-storage');
		const agents = path.join(root, 'acp-hub', 'agents');
		const { lines, log } = recordingLog();

		await migrateInstalls(source, agents, ['claude', 'codex'], log);

		expect(fs.existsSync(agents)).toBe(false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('0 of 2');
	});

	it('is a no-op the second time', async () => {
		const root = tempRoot();
		const source = path.join(root, 'global-storage');
		const agents = path.join(root, 'acp-hub', 'agents');
		writeInstall(path.join(source, 'claude'), 'claude');
		await migrateInstalls(source, agents, ['claude'], () => { });
		const { lines, log } = recordingLog();

		await migrateInstalls(source, agents, ['claude'], log);

		expect(readInstall(path.join(agents, 'claude')).entry).toBe('claude');
		expect(fs.existsSync(path.join(source, 'claude'))).toBe(false);
		expect(lines[0]).toContain('0 of 1');
	});

	it('leaves the folder alone when the shared root is the extension\'s own folder', async () => {
		const root = tempRoot();
		// What openSharedStore settles on when the shared root cannot be written.
		const shared = path.join(root, 'global-storage');
		const agents = path.join(shared, 'agents');
		writeInstall(path.join(shared, 'claude'), 'claude');
		const { lines, log } = recordingLog();

		await migrateInstalls(shared, agents, ['claude'], log);

		expect(readInstall(path.join(shared, 'claude')).entry).toBe('claude');
		expect(fs.existsSync(path.join(agents, 'claude'))).toBe(false);
		expect(lines).toEqual([]);
	});

	it('copies across volumes when the rename says the folder is on another one', async () => {
		const root = tempRoot();
		const source = path.join(root, 'global-storage');
		const agents = path.join(root, 'acp-hub', 'agents');
		writeInstall(path.join(source, 'claude'), 'claude');
		fsControl.crossDevice = true;

		await migrateInstalls(source, agents, ['claude'], () => { });

		expect(readInstall(path.join(agents, 'claude'))).toEqual({ entry: 'claude', pids: 'claude', log: 'claude' });
		expect(fs.existsSync(path.join(source, 'claude'))).toBe(false);
	});

	it('keeps a source whose copy failed, so the next activation can try again', async () => {
		const root = tempRoot();
		const source = path.join(root, 'global-storage');
		const agents = path.join(root, 'acp-hub', 'agents');
		const state = createFileStore(path.join(root, 'store')).state;
		writeInstall(path.join(source, 'claude'), 'claude');
		fsControl.crossDevice = true;
		fsControl.copyFails = true;

		await expect(migrateInstallsOnce({ sourceRoot: source, agentsRoot: agents, agentIds: ['claude'], state, log: () => { } }))
			.rejects.toThrow(/no space left/);

		expect(readInstall(path.join(source, 'claude')).entry).toBe('claude');
		// The half copy is gone, so it cannot pass for the install on the next run.
		expect(fs.existsSync(path.join(agents, 'claude'))).toBe(false);
		expect(state.get<boolean>(INSTALLS_MIGRATION_MARKER)).toBeUndefined();
	});

	it('runs once: the marker stops the next activation from moving anything', async () => {
		const root = tempRoot();
		const source = path.join(root, 'global-storage');
		const agents = path.join(root, 'acp-hub', 'agents');
		const storeRoot = path.join(root, 'store');
		writeInstall(path.join(source, 'claude'), 'claude');

		expect(await migrateInstallsOnce({ sourceRoot: source, agentsRoot: agents, agentIds: ['claude'], state: createFileStore(storeRoot).state, log: () => { } })).toBe(true);

		// An install that turns up in the old folder afterwards is left alone: the move already ran.
		writeInstall(path.join(source, 'codex'), 'codex');
		const { lines, log } = recordingLog();

		expect(await migrateInstallsOnce({ sourceRoot: source, agentsRoot: agents, agentIds: ['claude', 'codex'], state: createFileStore(storeRoot).state, log })).toBe(false);

		expect(fs.existsSync(path.join(source, 'codex'))).toBe(true);
		expect(fs.existsSync(path.join(agents, 'codex'))).toBe(false);
		expect(lines).toEqual([]);
		// The marker is on disk, so the activation after a reload leaves the folders alone too.
		expect(createFileStore(storeRoot).state.get<boolean>(INSTALLS_MIGRATION_MARKER)).toBe(true);
	});
});
