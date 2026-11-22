/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { discoverCustomizations, type CustomFile, type CustomizationSources } from './customizations';

/** How long a scan of the folders is served again, so a file added or removed shows up within this time. */
const CACHE_MS = 5_000;

export interface PromptFilesDeps {
	readonly home: string;
	/** The active VS Code profile's `prompts` folder, which holds the user-level files. */
	readonly profilePromptsDir: string;
	/** The folders of the window, which a chat with no folders of its own uses. */
	windowFolders(): readonly string[];
	/** An untrusted workspace contributes nothing, since its files could carry instructions aimed at the agent. */
	trusted(): boolean;
	/** The `chat.instructionsFilesLocations` and `chat.promptFilesLocations` settings. */
	locations(): CustomizationSources['locations'];
	now?(): number;
}

/**
 * The instruction and prompt files a chat may use, read from disk. A scan is
 * kept for a few seconds, so the requests of one turn read the same files and
 * give the same bytes, while a changed file is still picked up soon.
 */
export class PromptFiles {
	private readonly scans = new Map<string, { readonly at: number; readonly files: Promise<readonly CustomFile[]> }>();

	constructor(private readonly deps: PromptFilesDeps) { }

	get(chatFolders: readonly string[] | undefined): Promise<readonly CustomFile[]> {
		const now = this.deps.now?.() ?? Date.now();
		// The chat's own folders win over the window's: a window can show a chat of another folder.
		const chosen = chatFolders?.length ? chatFolders : this.deps.windowFolders();
		const folders = this.deps.trusted() ? [...chosen] : [];
		const key = JSON.stringify(folders);

		for (const [other, scan] of this.scans) {
			if (now - scan.at >= CACHE_MS) {
				this.scans.delete(other);
			}
		}
		const cached = this.scans.get(key);
		if (cached) {
			return cached.files;
		}
		const files = discoverCustomizations(this.deps.home, folders, {
			profilePromptsDir: this.deps.profilePromptsDir,
			locations: this.deps.locations(),
		}).then(found => found.files, error => {
			this.scans.delete(key);
			throw error;
		});
		this.scans.set(key, { at: now, files });
		return files;
	}
}
