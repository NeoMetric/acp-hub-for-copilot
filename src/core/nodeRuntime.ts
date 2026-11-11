/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Log } from './logging';

/** The Node the server needs at least; the bundle is built for Node 20. */
export const MIN_NODE_MAJOR = 20;

/** The Node downloaded when the machine has none that is new enough. */
export const DOWNLOADED_NODE_VERSION = '22.12.0';

const DOWNLOAD_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const NODE_DIST = 'https://nodejs.org/dist';

export interface NodeRuntimeOptions {
	/** The store root; a downloaded Node is kept under `<root>/node`. */
	readonly root: string;
	readonly log: Log;
	/** Whether a machine with no usable Node may download one. */
	readonly download?: boolean;
}

/**
 * A Node that can run the server on its own, so the server does not depend on the editor's binary.
 * `undefined` when there is none and none could be downloaded; the caller then falls back to the editor's.
 */
export async function resolveNode(options: NodeRuntimeOptions): Promise<string | undefined> {
	const system = await findSystemNode();
	if (system) {
		return system;
	}
	if (options.download === false) {
		return undefined;
	}
	try {
		return await ensureDownloadedNode(options);
	} catch (error) {
		options.log(`Could not download Node.js for the server: ${error instanceof Error ? error.message : String(error)}`, 'warn');
		return undefined;
	}
}

/** The first `node` on PATH, or in a well-known install folder, that is new enough. */
export async function findSystemNode(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const onWindows = process.platform === 'win32';
	const name = onWindows ? 'node.exe' : 'node';
	const directories = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(entry => entry.length > 0);
	if (onWindows) {
		for (const variable of ['ProgramFiles', 'ProgramFiles(x86)']) {
			if (env[variable]) {
				directories.push(path.join(env[variable]!, 'nodejs'));
			}
		}
		if (env.LOCALAPPDATA) {
			directories.push(path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
		}
	} else {
		directories.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');
	}
	const seen = new Set<string>();
	for (const directory of directories) {
		const candidate = path.join(directory, name);
		if (seen.has(candidate) || !await isFile(candidate)) {
			continue;
		}
		seen.add(candidate);
		if (await isNewEnough(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** Whether `node --version` names a major version the server can run on. */
async function isNewEnough(node: string): Promise<boolean> {
	const output = await new Promise<string>(resolve => {
		cp.execFile(node, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout));
	});
	const major = Number(/^v(\d+)\./.exec(output.trim())?.[1]);
	return Number.isInteger(major) && major >= MIN_NODE_MAJOR;
}

async function ensureDownloadedNode(options: NodeRuntimeOptions): Promise<string> {
	const onWindows = process.platform === 'win32';
	const directory = path.join(options.root, 'node', `v${DOWNLOADED_NODE_VERSION}`);
	const target = path.join(directory, onWindows ? 'node.exe' : 'node');
	if (await isFile(target)) {
		return target;
	}

	const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
	const platform = onWindows ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
	const base = `${NODE_DIST}/v${DOWNLOADED_NODE_VERSION}`;
	// Windows publishes the executable on its own; the others ship it inside a tarball.
	const remote = onWindows ? `win-${arch}/node.exe` : `node-v${DOWNLOADED_NODE_VERSION}-${platform}-${arch}.tar.xz`;

	options.log(`No Node.js ${MIN_NODE_MAJOR}+ was found on this machine; downloading Node.js ${DOWNLOADED_NODE_VERSION} for the server.`);
	await fs.promises.mkdir(directory, { recursive: true });
	const sums = (await fetchText(`${base}/SHASUMS256.txt`)).split(/\r?\n/);
	const expected = sums.map(line => line.trim().split(/\s+/)).find(parts => parts[1] === remote)?.[0];
	if (!expected) {
		throw new Error(`nodejs.org lists no checksum for ${remote}.`);
	}

	const download = path.join(directory, `${path.basename(remote)}.part`);
	try {
		await downloadTo(`${base}/${remote}`, download);
		const actual = await sha256Of(download);
		if (actual !== expected.toLowerCase()) {
			throw new Error('The downloaded Node.js does not match its published checksum.');
		}
		if (onWindows) {
			await fs.promises.rename(download, target);
		} else {
			await extractNode(download, directory, `node-v${DOWNLOADED_NODE_VERSION}-${platform}-${arch}/bin/node`);
			await fs.promises.rename(path.join(directory, `node-v${DOWNLOADED_NODE_VERSION}-${platform}-${arch}`, 'bin', 'node'), target);
			await fs.promises.chmod(target, 0o755);
		}
	} finally {
		await fs.promises.rm(download, { force: true });
		await fs.promises.rm(path.join(directory, `node-v${DOWNLOADED_NODE_VERSION}-${platform}-${arch}`), { recursive: true, force: true });
	}
	options.log(`Node.js ${DOWNLOADED_NODE_VERSION} is ready in ${directory}.`, 'debug');
	return target;
}

function extractNode(archive: string, destination: string, entry: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		cp.execFile('tar', ['-xJf', archive, '-C', destination, entry], { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true }, error => {
			if (error) {
				reject(new Error(`Could not unpack Node.js: ${error.message}`));
			} else {
				resolve();
			}
		});
	});
}

async function isFile(file: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(file)).isFile();
	} catch {
		return false;
	}
}

function sha256Of(file: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(file)
			.on('data', chunk => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}

async function fetchText(url: string): Promise<string> {
	const file = path.join(os.tmpdir(), `acp-hub-${crypto.randomUUID()}.txt`);
	try {
		await downloadTo(url, file);
		return await fs.promises.readFile(file, 'utf8');
	} finally {
		await fs.promises.rm(file, { force: true });
	}
}

/** Downloads over HTTPS only, following a few redirects, and checks the size when the server states it. */
function downloadTo(url: string, destination: string, redirects = 0): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (!url.startsWith('https://')) {
			reject(new Error(`Refusing to download from a non-HTTPS address: ${url}`));
			return;
		}
		const request = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, response => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirects >= MAX_REDIRECTS) {
					reject(new Error('Too many redirects while downloading Node.js.'));
					return;
				}
				downloadTo(new URL(response.headers.location, url).toString(), destination, redirects + 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`Downloading ${url} failed with HTTP ${status}.`));
				return;
			}
			const total = Number(response.headers['content-length']) || undefined;
			let received = 0;
			const file = fs.createWriteStream(destination);
			response.on('data', (chunk: Buffer) => {
				received += chunk.length;
			});
			response.on('error', reject);
			file.on('error', reject);
			file.on('finish', () => {
				if (total !== undefined && received !== total) {
					reject(new Error(`The download stopped early (${received} of ${total} bytes).`));
				} else {
					resolve();
				}
			});
			response.pipe(file);
		});
		request.on('timeout', () => request.destroy(new Error('The download timed out.')));
		request.on('error', reject);
	});
}
