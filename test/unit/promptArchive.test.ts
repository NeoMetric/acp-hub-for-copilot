import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptArchive } from '../../src/engine/chat/promptArchive';
import { shortHash } from '../../src/engine/chat/sessionStore';

describe('PromptArchive', () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-')); });
	afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

	it('gives back the prompt a hash was made from', async () => {
		const archive = new PromptArchive(path.join(dir, 'prompts'));
		await archive.remember('the saved prompt');
		expect(await archive.recall(shortHash('the saved prompt'))).toBe('the saved prompt');
	});

	it('knows nothing of a prompt it was not given, or of a file that no longer matches its hash', async () => {
		const archive = new PromptArchive(path.join(dir, 'prompts'));
		expect(await archive.recall(shortHash('other'))).toBeUndefined();
		await archive.remember('kept');
		fs.writeFileSync(path.join(dir, 'prompts', `${shortHash('kept')}.txt`), 'edited');
		expect(await archive.recall(shortHash('kept'))).toBeUndefined();
	});

	it('keeps nothing without a folder', async () => {
		const archive = new PromptArchive(undefined);
		await archive.remember('x');
		expect(await archive.recall(shortHash('x'))).toBeUndefined();
	});

	it('removes prompts unused for longer than saved sessions are kept', async () => {
		const archive = new PromptArchive(path.join(dir, 'prompts'));
		await archive.remember('old');
		await archive.remember('new');
		const old = path.join(dir, 'prompts', `${shortHash('old')}.txt`);
		const long = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
		fs.utimesSync(old, long, long);
		await archive.prune();
		expect(fs.existsSync(old)).toBe(false);
		expect(await archive.recall(shortHash('new'))).toBe('new');
	});
});
