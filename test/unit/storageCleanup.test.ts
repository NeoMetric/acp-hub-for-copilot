import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordStoragePath, removeRecordedStorage } from '../../src/core/storageCleanup';

const ID = 'neometric.acp-hub-for-copilot';
let temp: string;
let extensionDir: string;

function storage(...segments: string[]): string {
	const dir = path.join(temp, ...segments);
	fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'claude', 'agent.exe'), '');
	return dir;
}

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acphub-cleanup-'));
	extensionDir = path.join(temp, 'extension');
	fs.mkdirSync(extensionDir);
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

describe('storage cleanup', () => {
	it('removes the recorded global storage and nothing else', () => {
		const own = storage('User', 'globalStorage', ID);
		const sibling = storage('User', 'globalStorage', 'someone.else');
		recordStoragePath(extensionDir, own);

		expect(removeRecordedStorage(extensionDir, ID)).toEqual([own]);
		expect(fs.existsSync(own)).toBe(false);
		expect(fs.existsSync(sibling)).toBe(true);
	});

	it('records each path once', () => {
		const own = storage('User', 'globalStorage', ID);
		recordStoragePath(extensionDir, own);
		recordStoragePath(extensionDir, own);
		expect(JSON.parse(fs.readFileSync(path.join(extensionDir, 'storage-paths.json'), 'utf8'))).toEqual([own]);
	});

	it('ignores recorded folders that are not this extension\'s global storage', () => {
		const wrongName = storage('User', 'globalStorage', 'someone.else');
		const wrongParent = storage('Documents', ID);
		recordStoragePath(extensionDir, wrongName);
		recordStoragePath(extensionDir, wrongParent);

		expect(removeRecordedStorage(extensionDir, ID)).toEqual([]);
		expect(fs.existsSync(wrongName)).toBe(true);
		expect(fs.existsSync(wrongParent)).toBe(true);
	});

	it('does nothing without a marker or when the extension folder cannot be written', () => {
		expect(removeRecordedStorage(extensionDir, ID)).toEqual([]);
		expect(() => recordStoragePath(path.join(temp, 'missing'), 'x')).not.toThrow();
	});
});
