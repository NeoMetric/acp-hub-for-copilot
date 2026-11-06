/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCodexHome } from '../../../src/adapters/codexHome';

let storage: string;

beforeEach(() => {
	storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-home-'));
});

afterEach(() => {
	fs.rmSync(storage, { recursive: true, force: true });
});

describe('ensureCodexHome', () => {
	it('is a folder of its own inside the global storage, and exists afterwards', () => {
		const home = ensureCodexHome(storage);

		expect(home).toBe(path.join(storage, 'codex-home'));
		expect(fs.statSync(home).isDirectory()).toBe(true);
	});

	it('raises the time a call to the bridge may take, so Codex does not drop a question the user is still answering after 300 seconds', () => {
		const home = ensureCodexHome(storage);
		const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');

		expect(config).toContain('[mcp_servers.vscode]');
		expect(config).toMatch(/^tool_timeout_sec = 86400$/m);
		// Codex refuses an entry with no transport before it reads a session's servers, so the entry has an address that the session's own replaces.
		expect(config).toMatch(/^url = "http:\/\/127\.0\.0\.1:9\/"$/m);
	});

	it('brings an out-of-date config of its own up to date', () => {
		const home = ensureCodexHome(storage);
		const file = path.join(home, 'config.toml');
		fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').split('\n')[0]}\n[mcp_servers.vscode]\ntool_timeout_sec = 60\n`);

		ensureCodexHome(storage);

		expect(fs.readFileSync(file, 'utf8')).toMatch(/^tool_timeout_sec = 86400$/m);
	});

	it('does not touch a config the user wrote', () => {
		const home = path.join(storage, 'codex-home');
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, 'config.toml'), 'model = "mine"\n');

		ensureCodexHome(storage);

		expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe('model = "mine"\n');
	});

	it('leaves what an earlier start put there alone', () => {
		const home = ensureCodexHome(storage);
		fs.writeFileSync(path.join(home, 'marker'), 'kept');

		expect(ensureCodexHome(storage)).toBe(home);
		expect(fs.readFileSync(path.join(home, 'marker'), 'utf8')).toBe('kept');
	});
});
