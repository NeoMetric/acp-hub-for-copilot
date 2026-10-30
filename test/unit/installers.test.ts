import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import { findInstalled, findOnPath, getInstallState, installAgent, type InstallEnvironment } from '../../src/core/installers';

const { runNpm } = vi.hoisted(() => ({ runNpm: vi.fn() }));
vi.mock('../../src/core/npm', async importOriginal => ({
	...await importOriginal<Record<string, unknown>>(),
	runNpm,
}));

let temp: string;
let env: InstallEnvironment;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acphub-install-é ü-'));
	const manifestDir = path.join(temp, 'extension', 'adapters', 'demo');
	fs.mkdirSync(manifestDir, { recursive: true });
	fs.writeFileSync(path.join(manifestDir, 'package.json'), '{}');
	fs.writeFileSync(path.join(manifestDir, 'package-lock.json'), '{"lock":1}');
	env = { storageDir: path.join(temp, 'storage'), extensionDir: path.join(temp, 'extension'), log: () => { }, progress: () => { } };
	runNpm.mockReset();
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

function npmAdapter(): AgentAdapter {
	return {
		id: 'demo',
		displayName: 'Demo',
		install: { kind: 'npm', packageName: '@scope/demo-acp', version: '1.0.0', manifestDirectory: path.join('adapters', 'demo') },
	} as unknown as AgentAdapter;
}

/** Stands in for `npm ci`: lays out the package the way npm would. */
function fakeNpmCi(options: { withEntry: boolean }) {
	runNpm.mockImplementation((_args: string[], runOptions: { cwd: string }) => {
		const packageDir = path.join(runOptions.cwd, 'node_modules', '@scope', 'demo-acp');
		fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
		fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { demo: 'dist/index.js' } }));
		if (options.withEntry) {
			fs.writeFileSync(path.join(packageDir, 'dist', 'index.js'), '');
		}
		return Promise.resolve();
	});
}

describe('configured commands', () => {
	it('uses an adapter command override before looking for its downloaded server', async () => {
		const agent = {
			id: 'demo', displayName: 'Demo',
			install: { kind: 'download', version: '1', find: vi.fn().mockResolvedValue(undefined), install: vi.fn() },
			findCommandOverride: (settings: { command?: string }) => settings.command,
		} as unknown as AgentAdapter;
		const result = await findInstalled(agent, { ...env, settings: { command: 'custom-server' } });
		expect(result?.entryPath).toBe('custom-server');
	});
});

describe('installation progress', () => {
	it('reports npm progress and completion, including an already installed agent', async () => {
		fakeNpmCi({ withEntry: true });
		const report = vi.fn();
		await installAgent(npmAdapter(), env, report);
		expect(report.mock.calls.map(([update]) => update)).toEqual([
			{ agentId: 'demo', state: 'started' },
			{ agentId: 'demo', state: 'progress', message: 'Installing @scope/demo-acp@1.0.0' },
			{ agentId: 'demo', state: 'completed' },
		]);
		report.mockClear();
		await installAgent(npmAdapter(), env, report);
		expect(report.mock.calls.map(([update]) => update.state)).toEqual(['started', 'completed']);
	});

	it('forwards download messages and reports failures without changing the thrown error', async () => {
		const failure = new Error('offline');
		const report = vi.fn();
		const progress = vi.fn();
		const adapter = {
			id: 'dl', displayName: 'Dl',
			install: { kind: 'download', version: '1', find: async () => undefined, install: async (ctx: { progress(message: string): void }) => { ctx.progress('Downloading'); throw failure; } },
		} as unknown as AgentAdapter;
		await expect(installAgent(adapter, { ...env, progress }, report)).rejects.toBe(failure);
		expect(progress).toHaveBeenCalledWith('Downloading');
		expect(report.mock.calls.map(([update]) => update)).toEqual([
			{ agentId: 'dl', state: 'started' },
			{ agentId: 'dl', state: 'progress', message: 'Downloading' },
			{ agentId: 'dl', state: 'failed', error: failure },
		]);
	});

	it('reports fallback to a previous installation as successful', async () => {
		fakeNpmCi({ withEntry: true });
		await installAgent(npmAdapter(), env);
		fs.writeFileSync(path.join(env.extensionDir, 'adapters', 'demo', 'package-lock.json'), '{"lock":2}');
		runNpm.mockRejectedValue(new Error('offline'));
		const report = vi.fn();
		await installAgent(npmAdapter(), env, report);
		expect(report.mock.calls.map(([update]) => update)).toContainEqual({ agentId: 'demo', state: 'progress', message: 'Installation failed; using the previously installed adapter.' });
		expect(report.mock.calls.at(-1)?.[0].state).toBe('completed');
	});
});

describe('npm agents', () => {
	it('is not installed before installing', async () => {
		expect(await getInstallState(npmAdapter(), env)).toBe('not-installed');
	});

	it('installs from the lockfile, finds the entry, and does not install twice', async () => {
		fakeNpmCi({ withEntry: true });

		const first = await installAgent(npmAdapter(), env);
		const second = await installAgent(npmAdapter(), env);

		expect(first.entryPath.endsWith(path.join('dist', 'index.js'))).toBe(true);
		expect(second.entryPath).toBe(first.entryPath);
		expect(runNpm).toHaveBeenCalledTimes(1);
		expect(runNpm.mock.calls[0][0]).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
		expect(await getInstallState(npmAdapter(), env)).toBe('installed');
	});

	it('finds the previous installation after an upgrade fails', async () => {
		fakeNpmCi({ withEntry: true });
		const previous = await installAgent(npmAdapter(), env);
		fs.writeFileSync(path.join(env.extensionDir, 'adapters', 'demo', 'package-lock.json'), '{"lock":2}');
		runNpm.mockRejectedValue(new Error('offline'));
		expect((await installAgent(npmAdapter(), env)).entryPath).toBe(previous.entryPath);
		expect((await findInstalled(npmAdapter(), env))?.entryPath).toBe(previous.entryPath);
	});

	it('stays not installed when npm fails', async () => {
		runNpm.mockRejectedValue(new Error('offline'));
		await expect(installAgent(npmAdapter(), env)).rejects.toThrow('offline');
		expect(await getInstallState(npmAdapter(), env)).toBe('not-installed');
	});

	it('stays not installed when the package has no entry point', async () => {
		fakeNpmCi({ withEntry: false });
		await expect(installAgent(npmAdapter(), env)).rejects.toThrow('no entry point');
		expect(await getInstallState(npmAdapter(), env)).toBe('not-installed');
	});
});

describe('download agents', () => {
	it('hands the folder of the agent to the download functions', async () => {
		const program = path.join(temp, 'tool.exe');
		const seen: string[] = [];
		const adapter = {
			id: 'dl',
			displayName: 'Dl',
			install: {
				kind: 'download',
				version: '1',
				find: () => Promise.resolve(undefined),
				install: (ctx: { storageDir: string }) => { seen.push(ctx.storageDir); return Promise.resolve(program); },
			},
		} as unknown as AgentAdapter;

		const result = await installAgent(adapter, env);

		expect(result.entryPath).toBe(program);
		expect(seen).toEqual([path.join(env.storageDir, 'dl')]);
		expect(await findInstalled(adapter, env)).toBeUndefined();
	});

	it('reports an unsupported platform through the error the installer throws', async () => {
		const adapter = {
			id: 'dl',
			displayName: 'Dl',
			install: { kind: 'download', version: '1', find: () => Promise.resolve(undefined), install: () => Promise.reject(new Error('no build for this platform')) },
		} as unknown as AgentAdapter;
		await expect(installAgent(adapter, env)).rejects.toThrow('no build for this platform');
	});
});

describe('existing CLI agents', () => {
	it('finds a command on the PATH and says what is missing otherwise', async () => {
		const bin = path.join(temp, 'bin é');
		fs.mkdirSync(bin);
		const name = process.platform === 'win32' ? 'tool.cmd' : 'tool';
		fs.writeFileSync(path.join(bin, name), '');

		expect(findOnPath('tool', bin, '.CMD')?.toLowerCase()).toBe(path.join(bin, name).toLowerCase());
		expect(findOnPath('missing', bin, '.CMD')).toBeUndefined();

		const adapter = { id: 'cli', displayName: 'Cli', install: { kind: 'existing-cli', command: 'definitely-not-installed-xyz' } } as unknown as AgentAdapter;
		await expect(installAgent(adapter, env)).rejects.toThrow('definitely-not-installed-xyz');
	});
});
