/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { shortHash } from '../sessionStore';

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The session prompts that saved sessions opened with, by their hash. The prompt is the first thing
 * a model reads, so a resumed or forked session only hits the prompt cache when it is sent the very
 * text it was saved with, however the host's guidance has been reworded since.
 */
export class PromptArchive {
	constructor(private readonly dir: string | undefined) { }

	private fileOf(hash: string): string | undefined {
		return this.dir && /^[0-9a-f]+$/.test(hash) ? path.join(this.dir, `${hash}.txt`) : undefined;
	}

	/** Keeps the prompt under its hash; a failure only costs a later cache miss. */
	async remember(prompt: string | undefined): Promise<void> {
		const file = this.fileOf(shortHash(prompt ?? ''));
		if (!file || !prompt) {
			return;
		}
		try {
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			await fs.promises.writeFile(file, prompt, { encoding: 'utf8', flag: 'wx' }).catch(error => {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
				// A prompt in use stays young.
				return fs.promises.utimes(file, new Date(), new Date());
			});
		} catch {
			// Nothing to keep it in.
		}
	}

	/** The prompt with this hash, or `undefined` when it was not kept or no longer matches its hash. */
	async recall(hash: string): Promise<string | undefined> {
		const file = this.fileOf(hash);
		if (!file) {
			return undefined;
		}
		try {
			const prompt = await fs.promises.readFile(file, 'utf8');
			return shortHash(prompt) === hash ? prompt : undefined;
		} catch {
			return undefined;
		}
	}

	/** Removes the prompts nothing has needed for as long as saved sessions are kept. */
	async prune(): Promise<void> {
		if (!this.dir) {
			return;
		}
		try {
			for (const name of await fs.promises.readdir(this.dir)) {
				const file = path.join(this.dir, name);
				if (Date.now() - (await fs.promises.stat(file)).mtimeMs > MAX_AGE_MS) {
					await fs.promises.rm(file, { force: true });
				}
			}
		} catch {
			// Nothing kept yet.
		}
	}
}
