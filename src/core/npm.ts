/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { levelOfLine, type Log } from './logging';
import { killTree, pipeLines } from './processes';

export interface NpmRunOptions {
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly log: Log;
}

/** Runs `npm` with `args`, rejecting with the tail of its output when it fails. */
export async function runNpm(args: readonly string[], options: NpmRunOptions): Promise<void> {
	const npmCli = await findNpmCli();
	const onWindows = process.platform === 'win32';

	// With a resolved npm-cli.js, the extension host's own binary runs it as plain
	// node. Without one, npm has to be found through PATH; on Windows that means
	// npm.cmd, which can only be launched through a shell, so arguments need quoting.
	const command = npmCli ? process.execPath : onWindows ? 'npm.cmd' : 'npm';
	const shell = !npmCli && onWindows;
	const spawnArgs = npmCli ? [npmCli, ...args] : shell ? args.map(quoteForCmd) : [...args];

	// The resolved npm path identifies the machine's Node install, so only the
	// command line is narration and the path itself stays at Debug.
	options.log(`Running npm ${args.join(' ')}`);
	options.log(`Running ${npmCli ?? command} ${args.join(' ')}`, 'debug');

	await new Promise<void>((resolve, reject) => {
		const child = cp.spawn(command, spawnArgs, {
			cwd: options.cwd,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			shell,
		});

		let tail = '';
		const onLine = (line: string) => {
			tail = `${tail}\n${line}`.slice(-2000);
			options.log(line, levelOfLine(line));
		};
		if (child.stdout) {
			pipeLines(child.stdout, onLine);
		}
		if (child.stderr) {
			pipeLines(child.stderr, onLine);
		}

		let settled = false;
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};

		const timer = setTimeout(() => {
			options.log(`npm timed out after ${Math.round(options.timeoutMs / 60_000)} minute(s)`, 'error');
			if (child.pid) {
				void killTree(child.pid);
			}
			finish(new Error("Installing the ACP adapter timed out."));
		}, options.timeoutMs);

		child.on('error', error => {
			const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
			finish(new Error(missing
				? "npm could not be found. Install Node.js (which includes npm), then reload the window."
				: `Could not run npm: ${error.message}`));
		});
		child.on('close', code => {
			finish(code === 0 ? undefined : new Error(`npm exited with code ${code ?? 'null'}:${tail}`));
		});
	});
}

/** Quotes one argument for `cmd.exe`, which is what `shell: true` uses on Windows. */
export function quoteForCmd(argument: string): string {
	return `"${argument.replace(/"/g, '""')}"`;
}

/**
 * Locates npm's CLI script so it can be run with the extension host's own
 * binary. The extension host is Electron and often starts without the shell's
 * PATH (Dock or Activities launches), so well-known install locations are
 * searched in addition to PATH.
 */
export async function findNpmCli(): Promise<string | undefined> {
	const fromEnv = process.env.npm_execpath;
	if (fromEnv && /npm-cli\.js$/i.test(fromEnv) && await exists(fromEnv)) {
		return fromEnv;
	}

	const seen = new Set<string>();
	for (const directory of await candidateDirectories()) {
		for (const candidate of await cliCandidates(directory)) {
			if (!seen.has(candidate)) {
				seen.add(candidate);
				if (await exists(candidate)) {
					return candidate;
				}
			}
		}
	}
	return undefined;
}

/** Where `npm-cli.js` can be, given a directory that holds the `npm` launcher. */
async function cliCandidates(directory: string): Promise<string[]> {
	const candidates = [path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')];

	if (process.platform !== 'win32') {
		candidates.push(path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
		// `npm` is a symlink to npm-cli.js in nvm, fnm, Homebrew and distro packages.
		try {
			const target = await fs.promises.realpath(path.join(directory, 'npm'));
			if (/npm-cli\.js$/i.test(target)) {
				candidates.unshift(target);
			}
		} catch {
			// No npm launcher in this directory.
		}
	}

	return candidates;
}

async function candidateDirectories(): Promise<string[]> {
	const directories: string[] = (process.env.PATH ?? process.env.Path ?? '')
		.split(path.delimiter)
		.filter(entry => entry.length > 0);
	const home = os.homedir();

	for (const variable of ['NVM_SYMLINK', 'NODE_HOME']) {
		const value = process.env[variable];
		if (value) {
			directories.push(value);
		}
	}

	if (process.platform === 'win32') {
		for (const variable of ['ProgramFiles', 'ProgramFiles(x86)']) {
			const value = process.env[variable];
			if (value) {
				directories.push(path.join(value, 'nodejs'));
			}
		}
		if (process.env.LOCALAPPDATA) {
			directories.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'));
		}
		if (process.env.APPDATA) {
			directories.push(path.join(process.env.APPDATA, 'npm'));
		}
	} else {
		directories.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin');
		directories.push(...await versionedDirectories(path.join(home, '.nvm', 'versions', 'node'), ['bin']));
		directories.push(...await versionedDirectories(path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']));
		directories.push(...await versionedDirectories(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), ['installation', 'bin']));
		directories.push(...await versionedDirectories(path.join(home, '.asdf', 'installs', 'nodejs'), ['bin']));
	}

	return directories;
}

/** `<base>/<version>/<suffix>` for every version directory, newest version first. */
async function versionedDirectories(base: string, suffix: readonly string[]): Promise<string[]> {
	try {
		const versions = await fs.promises.readdir(base);
		return versions
			.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
			.map(version => path.join(base, version, ...suffix));
	} catch {
		return [];
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.promises.access(file);
		return true;
	} catch {
		return false;
	}
}
