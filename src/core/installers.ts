import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentAdapter, AgentSettings, InstallContext } from './adapter';
import type { Log } from './logging';
import { NpmInstaller } from './npmInstaller';

export type InstallState = 'installed' | 'not-installed';

/** Where an agent's files go and where the extension's own files are. */
export interface InstallEnvironment {
	/** The extension's global storage folder; each agent gets a folder of its own inside. */
	storageDir: string;
	/** The folder the extension is installed in. */
	extensionDir: string;
	settings?: AgentSettings;
	log: Log;
	progress(message: string): void;
}

export interface InstallResult {
	entryPath: string;
	installDir: string;
}

function npmInstallerFor(adapter: AgentAdapter, env: InstallEnvironment): NpmInstaller | undefined {
	const spec = adapter.install;
	if (spec.kind !== 'npm') {
		return undefined;
	}
	return new NpmInstaller(
		path.join(env.storageDir, adapter.id),
		path.join(env.extensionDir, spec.manifestDirectory),
		spec.packageName,
		spec.version,
		env.log,
		spec.entry,
	);
}

function contextFor(adapter: AgentAdapter, env: InstallEnvironment): InstallContext {
	return { storageDir: path.join(env.storageDir, adapter.id), log: env.log, progress: env.progress };
}

/** Looks for `command` in the folders of PATH; on Windows also with each PATHEXT extension. */
export function findOnPath(command: string, pathVariable = process.env.PATH ?? '', extensions = process.env.PATHEXT ?? '.EXE;.CMD;.BAT'): string | undefined {
	const suffixes = process.platform === 'win32' ? ['', ...extensions.split(';').filter(ext => ext.length > 0)] : [''];

	for (const folder of pathVariable.split(path.delimiter)) {
		if (folder.length === 0) {
			continue;
		}
		for (const suffix of suffixes) {
			const candidate = path.join(folder, command + suffix);
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return candidate;
			}
		}
	}
	return undefined;
}

/** The entry of an installed agent, or `undefined` when it is not installed. */
export async function findInstalled(adapter: AgentAdapter, env: InstallEnvironment): Promise<InstallResult | undefined> {
	const override = adapter.findCommandOverride?.(env.settings ?? {});
	if (override) { return { entryPath: override, installDir: '' }; }
	const spec = adapter.install;

	if (spec.kind === 'npm') {
		const installer = npmInstallerFor(adapter, env);
		const entry = await installer?.findInstalled();
		return entry && installer ? { entryPath: entry, installDir: installer.root } : undefined;
	}
	if (spec.kind === 'download') {
		const context = contextFor(adapter, env);
		const program = await spec.find(context);
		return program ? { entryPath: program, installDir: path.dirname(program) } : undefined;
	}
	const found = findOnPath(spec.command);
	return found ? { entryPath: found, installDir: '' } : undefined;
}

export async function getInstallState(adapter: AgentAdapter, env: InstallEnvironment): Promise<InstallState> {
	return (await findInstalled(adapter, env)) ? 'installed' : 'not-installed';
}

/** Installs the agent unless it is already there. An existing CLI cannot be installed from here. */
export async function installAgent(adapter: AgentAdapter, env: InstallEnvironment): Promise<InstallResult> {
	const spec = adapter.install;

	if (spec.kind === 'npm') {
		const installer = npmInstallerFor(adapter, env);
		if (!installer) {
			throw new Error('No npm installer for this agent.');
		}
		const entry = await installer.install();
		return { entryPath: entry, installDir: installer.root };
	}
	if (spec.kind === 'download') {
		const program = await spec.install(contextFor(adapter, env));
		return { entryPath: program, installDir: path.dirname(program) };
	}
	const found = findOnPath(spec.command);
	if (!found) {
		throw new Error(`${adapter.displayName} needs the "${spec.command}" command, which was not found on your PATH. Install it and try again.`);
	}
	return { entryPath: found, installDir: '' };
}
