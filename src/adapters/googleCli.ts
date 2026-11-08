import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import type { Log } from '../core/logging';

/**
 * Google's Antigravity CLI (`agy`), which the agent runs as `agy acp`. Each extension release pins
 * one version, so an extension update brings its CLI with it. To move to a newer CLI, read
 * `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json`
 * for each platform below (`windows_amd64`, `darwin_arm64`, `linux_amd64`, ...) and copy its
 * `version`, `url` and `sha512` here.
 */
export const AGY_VERSION = '1.5.3';

const RELEASE_ROOT = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}-6604829099950080`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const MARKER_FILE = 'installed-version';

export interface AgyRelease {
	url: string;
	sha512: string;
	/** The program's name once installed. */
	command: string;
	/** The program inside a `.tar.gz` download; absent when the download is the program itself. */
	archiveEntry?: string;
}

/** The pinned release for a platform, or `undefined` where Google publishes none. */
export function agyReleaseFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AgyRelease | undefined {
	switch (`${platform}-${arch}`) {
		case 'win32-x64':
			return { url: `${RELEASE_ROOT}/windows-x64/cli_windows_x64.exe`, command: 'agy.exe', sha512: 'b282c10ca3266078806d7bcae66db8ec0c6e2953ee6e62de1da6499182d24c02fffa8a74c620817bd35b15cf5f5a18287fb1ab30bcb9c7a67592c248696ed909' };
		case 'win32-arm64':
			return { url: `${RELEASE_ROOT}/windows-arm/cli_windows_arm64.exe`, command: 'agy.exe', sha512: '62f09bb3dc3c8bb142de2ad87c855c524ca0efb70bb9a54430121a021b14060fa3aa39d2a0e0b40b6198ee8ff26af59ca5911ff5ce19c70fd8ac2cf4e3c7d699' };
		case 'darwin-x64':
			return { url: `${RELEASE_ROOT}/darwin-x64/cli_mac_x64.tar.gz`, command: 'agy', archiveEntry: 'antigravity', sha512: '865f6ec3d6a7bddff3a5bffda6df12db2df8abfedf3064acb4426db2ec0ce59de3d49d1378960df7a4646ffdbd74601f23184f0d23abfc1cd6717a1bd29e6922' };
		case 'darwin-arm64':
			return { url: `${RELEASE_ROOT}/darwin-arm/cli_mac_arm64.tar.gz`, command: 'agy', archiveEntry: 'antigravity', sha512: '3215656cfe5336bce310365f61de7c85b4946a14de506747837106dfaf948dcff303c47e648e06fbbb73a8702538eae171e675f2910e4f49b280549018b46e95' };
		case 'linux-x64':
			return { url: `${RELEASE_ROOT}/linux-x64/cli_linux_x64.tar.gz`, command: 'agy', archiveEntry: 'antigravity', sha512: 'e363e1b17daaac2589f18e6973429c039fd5a5e5c15e9c0852fa349836f3992b10fe84732bc8d8c8208e149f0304f15aba9dec696d12efeed03917492c0580eb' };
		case 'linux-arm64':
			return { url: `${RELEASE_ROOT}/linux-arm/cli_linux_arm64.tar.gz`, command: 'agy', archiveEntry: 'antigravity', sha512: 'c2fac818b3c1bb224079df03a714ccba99728b6a3a41d86d247ab2feb8582a43840c5032f1c2b75e72667623d5503e7ffda2712c4f37b6ee19f99c3fcfb25bae' };
		default:
			return undefined;
	}
}

export type DownloadProgress = (received: number, total: number | undefined) => void;
export type FetchTo = (url: string, destination: string, onProgress?: DownloadProgress) => Promise<void>;

/**
 * Keeps the Antigravity CLI in the agent's storage folder, one folder per version (`v1.5.3`).
 * Nothing is downloaded unless `install` is called.
 */
export class AgyInstaller {

	constructor(
		private readonly root: string,
		private readonly log: Log,
		private readonly release: AgyRelease | null = agyReleaseFor() ?? null,
		private readonly fetchTo: FetchTo = download,
	) { }

	private get versionDirectory(): string {
		return path.join(this.root, `v${AGY_VERSION}`);
	}

	/** The program when the pinned version is fully installed. */
	async find(): Promise<string | undefined> {
		return this.release ? this.completeInstall(this.versionDirectory, AGY_VERSION) : undefined;
	}

	/** The newest fully installed earlier version of the CLI; it stays in use until the pinned one is installed. */
	async findPrevious(): Promise<string | undefined> {
		for (const name of await this.olderVersionFolders()) {
			const file = await this.completeInstall(path.join(this.root, name), name.slice(1));
			if (file) {
				return file;
			}
		}
		return undefined;
	}

	/** Whether something older is installed (an earlier CLI, or the ACP server earlier releases ran), so the pinned version is worth fetching unasked. */
	async hasOlderInstall(): Promise<boolean> {
		return (await this.olderVersionFolders()).length > 0;
	}

	/** Downloads, checks and installs the pinned version unless it is already there, then removes older installs. */
	async install(onProgress?: DownloadProgress): Promise<string> {
		const existing = await this.find();
		if (existing) {
			return existing;
		}
		const release = this.release;
		if (!release) {
			throw new Error(`Google publishes no Antigravity CLI for ${process.platform}-${process.arch}.`);
		}

		await fs.promises.mkdir(this.root, { recursive: true });
		// A folder of its own per attempt, so two windows installing at once never share files.
		const work = await fs.promises.mkdtemp(path.join(this.root, `install-${process.pid}-`));
		try {
			const downloaded = path.join(work, 'download');
			this.log(`Downloading the Antigravity CLI ${AGY_VERSION} from ${release.url}`);
			await this.fetchTo(release.url, downloaded, onProgress);
			if (await sha512Of(downloaded) !== release.sha512) {
				throw new Error('The downloaded Antigravity CLI failed its checksum check, so it was not installed.');
			}

			const unpacked = path.join(work, 'unpacked');
			await fs.promises.mkdir(unpacked);
			const program = path.join(unpacked, release.command);
			if (release.archiveEntry) {
				await extractTarGz(downloaded, unpacked, release.archiveEntry);
				await fs.promises.rename(path.join(unpacked, release.archiveEntry), program);
			} else {
				await fs.promises.rename(downloaded, program);
			}
			if (process.platform !== 'win32') {
				await fs.promises.chmod(program, 0o755);
			}
			// Written last: its presence is what marks the install as complete.
			await fs.promises.writeFile(path.join(unpacked, MARKER_FILE), AGY_VERSION, 'utf8');

			if (!await this.find()) {
				await fs.promises.rm(this.versionDirectory, { recursive: true, force: true });
				await fs.promises.rename(unpacked, this.versionDirectory);
			}
			this.log(`Installed the Antigravity CLI ${AGY_VERSION} in ${this.versionDirectory}`);
		} finally {
			await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
		}

		await this.removeOlderInstalls();
		const installed = await this.find();
		if (!installed) {
			throw new Error('The Antigravity CLI was installed but could not be found afterwards.');
		}
		return installed;
	}

	private async completeInstall(directory: string, version: string): Promise<string | undefined> {
		try {
			const marker = await fs.promises.readFile(path.join(directory, MARKER_FILE), 'utf8');
			const file = path.join(directory, this.release!.command);
			await fs.promises.access(file);
			return marker.trim() === version ? file : undefined;
		} catch {
			return undefined;
		}
	}

	/** `v<version>` folders other than the pinned one, newest first. */
	private async olderVersionFolders(): Promise<string[]> {
		if (!this.release) {
			return [];
		}
		let names: string[];
		try {
			names = await fs.promises.readdir(this.root);
		} catch {
			return [];
		}
		const current = path.basename(this.versionDirectory);
		return names.filter(name => /^v\d+(\.\d+)*$/.test(name) && name !== current).sort(compareVersionsNewestFirst);
	}

	/** Best effort: a window still running an older version may hold its files open. */
	private async removeOlderInstalls(): Promise<void> {
		for (const name of await this.olderVersionFolders()) {
			await fs.promises.rm(path.join(this.root, name), { recursive: true, force: true }).catch(error => {
				this.log(`Could not remove the old files "${name}": ${error instanceof Error ? error.message : String(error)}`, 'warn');
			});
		}
	}
}

/** Orders folder names such as `v1.5.10` and `v1.5.3` by their numbers, newest first. */
function compareVersionsNewestFirst(a: string, b: string): number {
	const parts = (name: string) => name.slice(1).split('.').map(Number);
	const left = parts(a);
	const right = parts(b);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (right[index] ?? 0) - (left[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

function sha512Of(file: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash('sha512');
		fs.createReadStream(file)
			.on('data', chunk => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}

/** Downloads over HTTPS only, following a few redirects, and checks the size when the server states it. */
function download(url: string, destination: string, onProgress?: DownloadProgress, redirects = 0): Promise<void> {
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
					reject(new Error('Too many redirects while downloading the Antigravity CLI.'));
					return;
				}
				download(new URL(response.headers.location, url).toString(), destination, onProgress, redirects + 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`Downloading the Antigravity CLI failed with HTTP ${status}.`));
				return;
			}

			const total = Number(response.headers['content-length']) || undefined;
			let received = 0;
			const file = fs.createWriteStream(destination);
			response.on('data', (chunk: Buffer) => {
				received += chunk.length;
				onProgress?.(received, total);
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

/** Takes one file out of a `.tar.gz` with the system `tar`, which every supported platform has. */
function extractTarGz(archive: string, destination: string, entry: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		cp.execFile('tar', ['-xzf', archive, '-C', destination, entry], { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true }, error => {
			if (!error) {
				resolve();
			} else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new Error('Could not unpack the Antigravity CLI because "tar" is not installed.'));
			} else {
				reject(new Error(`Could not unpack the Antigravity CLI: ${error.message}`));
			}
		});
	});
}
