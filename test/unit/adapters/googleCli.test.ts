import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGY_VERSION, AgyInstaller, agyReleaseFor, type AgyRelease } from '../../../src/adapters/googleCli';

let temp: string;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acphub-google-cli-é -'));
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

const sha512 = (data: Buffer | string) => crypto.createHash('sha512').update(data).digest('hex');

describe('agyReleaseFor', () => {
	it('picks the download of each supported platform', () => {
		expect(agyReleaseFor('win32', 'x64')?.url).toMatch(/\/windows-x64\/cli_windows_x64\.exe$/);
		expect(agyReleaseFor('win32', 'arm64')?.url).toMatch(/\/windows-arm\/cli_windows_arm64\.exe$/);
		expect(agyReleaseFor('darwin', 'x64')?.url).toMatch(/\/darwin-x64\/cli_mac_x64\.tar\.gz$/);
		expect(agyReleaseFor('darwin', 'arm64')?.url).toMatch(/\/darwin-arm\/cli_mac_arm64\.tar\.gz$/);
		expect(agyReleaseFor('linux', 'x64')?.url).toMatch(/\/linux-x64\/cli_linux_x64\.tar\.gz$/);
		expect(agyReleaseFor('linux', 'arm64')?.url).toMatch(/\/linux-arm\/cli_linux_arm64\.tar\.gz$/);
	});

	it('downloads from Google over HTTPS, with a SHA-512 to check, for the pinned version', () => {
		for (const [platform, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
			const release = agyReleaseFor(platform, arch);
			expect(release?.url).toMatch(new RegExp(`^https://storage\\.googleapis\\.com/antigravity-public/antigravity-cli/${AGY_VERSION.replace(/\./g, '\\.')}-`));
			expect(release?.sha512).toMatch(/^[0-9a-f]{128}$/);
		}
	});

	it('names the program agy.exe on Windows and unpacks agy from the archive elsewhere', () => {
		expect(agyReleaseFor('win32', 'x64')?.command).toBe('agy.exe');
		expect(agyReleaseFor('win32', 'x64')?.archiveEntry).toBeUndefined();
		expect(agyReleaseFor('linux', 'x64')).toMatchObject({ command: 'agy', archiveEntry: 'antigravity' });
	});

	it('is undefined on platforms without a build', () => {
		expect(agyReleaseFor('freebsd', 'x64')).toBeUndefined();
		expect(agyReleaseFor('win32', 'ia32')).toBeUndefined();
	});
});

describe('AgyInstaller', () => {
	const program = Buffer.from('agy program');
	const exeRelease: AgyRelease = { url: 'https://storage.googleapis.com/x/agy.exe', sha512: sha512(program), command: 'agy.exe' };

	/** A download that writes `data` to the destination, as the real one does. */
	const serving = (data: Buffer) => vi.fn(async (_url: string, destination: string) => { fs.writeFileSync(destination, data); });

	function installed(version: string, command = 'agy.exe', marker = version): string {
		const directory = path.join(temp, `v${version}`);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, command), '');
		fs.writeFileSync(path.join(directory, 'installed-version'), marker);
		return path.join(directory, command);
	}

	it('finds nothing until the install is marked complete', async () => {
		const installer = new AgyInstaller(temp, vi.fn(), exeRelease);
		expect(await installer.find()).toBeUndefined();

		fs.mkdirSync(path.join(temp, `v${AGY_VERSION}`));
		fs.writeFileSync(path.join(temp, `v${AGY_VERSION}`, 'agy.exe'), '');
		expect(await installer.find()).toBeUndefined();
	});

	it('finds a complete install of the pinned version only', async () => {
		const file = installed(AGY_VERSION);
		expect(await new AgyInstaller(temp, vi.fn(), exeRelease).find()).toBe(file);

		fs.writeFileSync(path.join(temp, `v${AGY_VERSION}`, 'installed-version'), '0.0.1');
		expect(await new AgyInstaller(temp, vi.fn(), exeRelease).find()).toBeUndefined();
	});

	it('keeps the newest earlier agy usable until the pinned one is in place', async () => {
		installed('1.5.1');
		const newer = installed('1.5.2');
		const installer = new AgyInstaller(temp, vi.fn(), exeRelease);

		expect(await installer.findPrevious()).toBe(newer);
	});

	it('never takes the old Antigravity ACP server for an earlier agy', async () => {
		installed('1.4.5', 'agy_acp_server.exe');

		expect(await new AgyInstaller(temp, vi.fn(), exeRelease).findPrevious()).toBeUndefined();
	});

	it('wants an update when anything older is installed, including the old ACP server', async () => {
		const installer = new AgyInstaller(temp, vi.fn(), exeRelease);
		expect(await installer.hasOlderInstall()).toBe(false);

		installed('1.4.5', 'agy_acp_server.exe');
		expect(await installer.hasOlderInstall()).toBe(true);
	});

	it('downloads, checks and installs the program, then removes older installs', async () => {
		installed('1.4.5', 'agy_acp_server.exe');
		const fetchTo = serving(program);
		const installer = new AgyInstaller(temp, vi.fn(), exeRelease, fetchTo);

		const file = await installer.install();

		expect(fetchTo).toHaveBeenCalledWith(exeRelease.url, expect.any(String), undefined);
		expect(file).toBe(path.join(temp, `v${AGY_VERSION}`, 'agy.exe'));
		expect(fs.readFileSync(file)).toEqual(program);
		expect(await installer.find()).toBe(file);
		expect(fs.readdirSync(temp)).toEqual([`v${AGY_VERSION}`]);
	});

	it('refuses a download whose checksum does not match, and leaves nothing behind', async () => {
		const installer = new AgyInstaller(temp, vi.fn(), exeRelease, serving(Buffer.from('tampered')));

		await expect(installer.install()).rejects.toThrow('checksum');
		expect(fs.readdirSync(temp)).toEqual([]);
	});

	it('unpacks agy from a .tar.gz release', async () => {
		const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'acphub-agy-tar-'));
		try {
			fs.writeFileSync(path.join(staging, 'antigravity'), program);
			const archive = path.join(staging, 'agy.tar.gz');
			cp.execFileSync('tar', ['-czf', archive, '-C', staging, 'antigravity']);
			const data = fs.readFileSync(archive);
			const release: AgyRelease = { url: 'https://storage.googleapis.com/x/agy.tar.gz', sha512: sha512(data), command: 'agy', archiveEntry: 'antigravity' };

			const file = await new AgyInstaller(temp, vi.fn(), release, serving(data)).install();

			expect(file).toBe(path.join(temp, `v${AGY_VERSION}`, 'agy'));
			expect(fs.readFileSync(file)).toEqual(program);
		} finally {
			fs.rmSync(staging, { recursive: true, force: true });
		}
	});

	it('does not download when the pinned version is installed', async () => {
		const file = installed(AGY_VERSION);
		const fetchTo = serving(program);

		await expect(new AgyInstaller(temp, vi.fn(), exeRelease, fetchTo).install()).resolves.toBe(file);
		expect(fetchTo).not.toHaveBeenCalled();
	});

	it('refuses a download that is not HTTPS', async () => {
		const installer = new AgyInstaller(temp, vi.fn(), { ...exeRelease, url: 'http://storage.googleapis.com/x/agy.exe' });

		await expect(installer.install()).rejects.toThrow('non-HTTPS');
		expect(fs.readdirSync(temp)).toEqual([]);
	});

	it('explains when there is no build for the platform', async () => {
		const installer = new AgyInstaller(temp, vi.fn(), null);

		expect(await installer.find()).toBeUndefined();
		await expect(installer.install()).rejects.toThrow('publishes no Antigravity CLI');
	});
});
