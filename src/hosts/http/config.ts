/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Log } from '../../engine/ports/host';
import type { ConfigReader } from '../../engine/ports/state';

/** The section of the document the settings live under, which VS Code names in `getConfiguration`. */
const SECTION = 'acpHub';

/** The setting naming the folder a chat works in when its request names none. */
export const DEFAULT_WORKSPACE = 'defaultWorkspace';

/** The settings file of a store root: `<root>/config.json`. */
export function configFileOf(root: string): string {
	return path.join(root, 'config.json');
}

/**
 * `config.json` as the engine's settings reader. A section is a dotted path
 * below `acpHub`, exactly as `vscode.workspace.getConfiguration('acpHub')` reads
 * it, so `readAgentSettings` works unchanged: `agents.claude.model` is
 * `acpHub.agents.claude.model` in the file.
 */
export class FileConfig implements ConfigReader {

	private document: unknown = {};
	private stamp = -1;

	constructor(readonly file: string, private readonly log?: Log) {
		this.reload();
	}

	/** Re-reads the file, so an edit applies to the next request without a restart. */
	reload(): void {
		try {
			this.stamp = fs.statSync(this.file).mtimeMs;
		} catch {
			this.stamp = -1;
			this.document = {};
			return;
		}
		try {
			this.document = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		} catch (error) {
			this.document = {};
			this.log?.(`Could not read ${this.file} (${messageOf(error)}); the host runs without settings.`, 'warn');
		}
	}

	get<T>(section: string): T | undefined {
		this.refresh();
		let current: unknown = this.document;
		for (const key of `${SECTION}.${section}`.split('.')) {
			if (typeof current !== 'object' || current === null) {
				return undefined;
			}
			current = (current as Record<string, unknown>)[key];
		}
		return current as T | undefined;
	}

	/** Writes one `acpHub.<section>` value, leaving the rest of the document as it was. */
	async set(section: string, value: unknown): Promise<void> {
		this.refresh();
		const document: Record<string, unknown> = isObject(this.document) ? this.document : {};
		const keys = `${SECTION}.${section}`.split('.');
		let container = document;
		for (const key of keys.slice(0, -1)) {
			if (!isObject(container[key])) {
				container[key] = {};
			}
			container = container[key] as Record<string, unknown>;
		}
		container[keys[keys.length - 1]] = value;
		await writeAtomic(this.file, `${JSON.stringify(document, null, '\t')}\n`);
		this.reload();
	}

	/** Reloads when the file changed since it was last read. */
	private refresh(): void {
		let stamp: number;
		try {
			stamp = fs.statSync(this.file).mtimeMs;
		} catch {
			stamp = -1;
		}
		if (stamp !== this.stamp) {
			this.reload();
		}
	}
}

/** The settings of `root`; a file that is absent or unreadable reads as no settings at all. */
export function loadConfig(root: string, log?: Log): FileConfig {
	return new FileConfig(configFileOf(root), log);
}

/** The folder a chat works in when its request names none, as the operator configured it. */
export function defaultWorkspaceOf(config: ConfigReader): string | undefined {
	const value = config.get<unknown>(DEFAULT_WORKSPACE);
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces the file in one step, so a reader never sees half a document. */
async function writeAtomic(file: string, text: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fs.promises.writeFile(temporary, text, 'utf8');
	await fs.promises.rename(temporary, file);
}
