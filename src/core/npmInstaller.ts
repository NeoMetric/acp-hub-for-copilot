/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Log } from './logging';
import { runNpm } from './npm';

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const LOCK_POLL_MS = 1_000;
/** A lock older than the longest possible install belongs to a process that died. */
const LOCK_STALE_MS = INSTALL_TIMEOUT_MS + 60_000;

const MARKER_FILE = 'installed-version';
const LOCK_DIRECTORY = '.install-lock';

/**
 * Installs the adapter into the extension's global storage from the lockfile
 * that ships with the extension, so every user gets the same dependency tree
 * with verified integrity hashes, and no package scripts run.
 */
export class NpmInstaller {

	/**
	 * @param root Where the adapter is installed (inside global storage).
	 * @param manifestDirectory The folder in the extension with `package.json` and `package-lock.json`.
	 */
	constructor(
		readonly root: string,
		private readonly manifestDirectory: string,
		private readonly packageName: string,
		private readonly version: string,
		private readonly log: Log,
	) { }

	/** The adapter's entry point when the current version is installed, else `undefined`. */
	async findInstalled(): Promise<string | undefined> {
		const expected = await this.expectedMarker();
		if (!expected) {
			return undefined;
		}
		const directory = versionDirectory(this.root, expected);
		const marker = await readTextIfExists(path.join(directory, MARKER_FILE));
		if (marker?.trim() !== expected) {
			return undefined;
		}
		return findAdapterEntry(directory, this.packageName);
	}

	/** Installs the adapter unless the current version is already there. */
	async install(): Promise<string> {
		const existing = await this.findInstalled();
		if (existing) {
			this.log(`Using the installed ${this.packageName}@${this.version}`);
			this.log(`Using ${this.packageName}@${this.version} from ${this.root}`, 'debug');
			return existing;
		}

		await fs.promises.mkdir(this.root, { recursive: true });
		const release = await this.acquireLock();
		try {
			// Another window may have finished the install while this one waited.
			const installedMeanwhile = await this.findInstalled();
			if (installedMeanwhile) {
				return installedMeanwhile;
			}
			try {
				return await this.runInstall();
			} catch (error) {
				const fallback = await this.findPreviousInstall();
				if (!fallback) {
					throw error;
				}
				this.log(`Could not install ${this.packageName}@${this.version}; using the previously installed adapter instead.`, 'warn');
				this.log(`Could not install ${this.packageName}@${this.version} (${error instanceof Error ? error.message : String(error)}); using the previously installed adapter ${fallback}`, 'debug');
				return fallback;
			}
		} finally {
			await release();
		}
	}

	/**
	 * Installs into a folder named after the version, so a failure here never
	 * touches the adapter an earlier extension version installed.
	 */
	private async runInstall(): Promise<string> {
		const marker = await this.expectedMarker();
		if (!marker) {
			throw new Error(`The extension is missing ${path.join(this.manifestDirectory, 'package-lock.json')}; reinstall the extension.`);
		}
		const directory = versionDirectory(this.root, marker);
		this.log(`Installing ${this.packageName}@${this.version} into the extension's storage folder`);
		this.log(`Installing ${this.packageName}@${this.version} into ${directory}`, 'debug');

		// Start clean: leftovers of an interrupted attempt for this same version.
		await fs.promises.rm(directory, { recursive: true, force: true });
		await fs.promises.mkdir(directory, { recursive: true });
		for (const file of ['package.json', 'package-lock.json']) {
			await fs.promises.copyFile(path.join(this.manifestDirectory, file), path.join(directory, file));
		}

		await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
			cwd: directory,
			timeoutMs: INSTALL_TIMEOUT_MS,
			log: this.log,
		});

		const entry = await findAdapterEntry(directory, this.packageName);
		if (!entry) {
			throw new Error(`The ACP adapter was installed but no entry point was found in ${path.join(directory, 'node_modules')}.`);
		}

		// Written last: its presence is what marks the install as complete.
		await fs.promises.writeFile(path.join(directory, MARKER_FILE), marker, 'utf8');
		this.log(`Installed ${this.packageName}@${this.version}`);
		this.log(`Installed ${this.packageName}@${this.version} (${entry})`, 'debug');

		await this.pruneOthers(directory);
		return entry;
	}

	/** A complete install left by an earlier version of the package. */
	private async findPreviousInstall(): Promise<string | undefined> {
		let names: string[];
		try {
			names = await fs.promises.readdir(this.root);
		} catch {
			return undefined;
		}
		const versioned = names.filter(name => name.startsWith('v')).sort().reverse().map(name => path.join(this.root, name));
		for (const directory of versioned) {
			if (await readTextIfExists(path.join(directory, MARKER_FILE)) === undefined) {
				continue;
			}
			const entry = await findAdapterEntry(directory, this.packageName);
			if (entry) {
				return entry;
			}
		}
		return undefined;
	}

	/** Removes earlier versions once the new install is complete. Best effort. */
	private async pruneOthers(keep: string): Promise<void> {
		let names: string[];
		try {
			names = await fs.promises.readdir(this.root);
		} catch {
			return;
		}
		const keepName = path.basename(keep);
		for (const name of names) {
			if (name === keepName || name === LOCK_DIRECTORY) {
				continue;
			}
			try {
				await fs.promises.rm(path.join(this.root, name), { recursive: true, force: true });
			} catch (error) {
				// A window still running an older version may hold files open. The name is
				// part of a path, so it stays at Debug with the reason.
				this.log('Could not remove the files of an older adapter install.', 'warn');
				this.log(`Could not remove old adapter files "${name}": ${error instanceof Error ? error.message : String(error)}`, 'debug');
			}
		}
	}

	/** The version plus a digest of the lockfile, so a changed dependency tree reinstalls. */
	private async expectedMarker(): Promise<string | undefined> {
		const lock = await readTextIfExists(path.join(this.manifestDirectory, 'package-lock.json'));
		if (lock === undefined) {
			return undefined;
		}
		const digest = crypto.createHash('sha256').update(lock).digest('hex').slice(0, 16);
		return `${this.version}+${digest}`;
	}

	/** Takes an exclusive lock shared by all windows; returns the function that releases it. */
	private async acquireLock(): Promise<() => Promise<void>> {
		const lockPath = path.join(this.root, LOCK_DIRECTORY);
		const deadline = Date.now() + LOCK_STALE_MS;

		for (;;) {
			try {
				await fs.promises.mkdir(lockPath);
				return async () => {
					await fs.promises.rm(lockPath, { recursive: true, force: true });
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
			}

			if (await isOlderThan(lockPath, LOCK_STALE_MS)) {
				this.log('Removing a stale adapter install lock');
				await fs.promises.rm(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error("Another window is still installing the ACP adapter. Try again in a few minutes.");
			}
			if (await this.findInstalled()) {
				// Nothing left to install; the holder is just finishing up.
				return async () => { };
			}
			await new Promise<void>(resolve => setTimeout(resolve, LOCK_POLL_MS));
		}
	}
}

/** The folder one adapter version lives in; `+` is replaced to keep the name filesystem-safe. */
function versionDirectory(root: string, marker: string): string {
	return path.join(root, `v${marker.replace(/[^\w.-]/g, '-')}`);
}

/** Resolves the adapter's `bin` entry point from its installed package.json. */
export async function findAdapterEntry(root: string, packageName: string): Promise<string | undefined> {
	const packageDir = path.join(root, 'node_modules', ...packageName.split('/'));

	let manifest: { bin?: string | Record<string, string> };
	try {
		manifest = JSON.parse(await fs.promises.readFile(path.join(packageDir, 'package.json'), 'utf8'));
	} catch {
		return undefined;
	}

	let relative: string | undefined;
	if (typeof manifest.bin === 'string') {
		relative = manifest.bin;
	} else if (manifest.bin && typeof manifest.bin === 'object') {
		relative = Object.values(manifest.bin)[0];
	}
	if (!relative) {
		return undefined;
	}

	const entry = path.resolve(packageDir, relative);
	try {
		await fs.promises.access(entry);
		return entry;
	} catch {
		return undefined;
	}
}

async function readTextIfExists(file: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

async function isOlderThan(file: string, milliseconds: number): Promise<boolean> {
	try {
		const stats = await fs.promises.stat(file);
		return Date.now() - stats.mtimeMs > milliseconds;
	} catch {
		return false;
	}
}
