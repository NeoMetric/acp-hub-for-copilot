import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dumpRequest } from '../../src/composition/headless';
import type { ChatRequest } from '../../src/engine/model/chat';

const request = { chatId: 'chat/1', cwd: 'C:/work', messages: [], tools: [] } as ChatRequest;
const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('dumpRequest', () => {
	it('writes the request as JSON only when the setting is on', () => {
		const folder = path.join(tempRoot(), 'requests');
		dumpRequest(folder, request, { dumpRequests: false }, vi.fn());
		expect(fs.existsSync(folder)).toBe(false);

		dumpRequest(folder, request, { dumpRequests: true }, vi.fn());
		const files = fs.readdirSync(folder);
		expect(files).toHaveLength(1);
		expect(JSON.parse(fs.readFileSync(path.join(folder, files[0]), 'utf8')).chatId).toBe('chat/1');
	});

	it('logs instead of throwing when the folder cannot be written', () => {
		const blocker = path.join(tempRoot(), 'file');
		fs.writeFileSync(blocker, '');
		const log = vi.fn();
		dumpRequest(path.join(blocker, 'requests'), request, { dumpRequests: true }, log);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not write the request dump'), 'warn');
	});
});
