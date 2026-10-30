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

	it('leaves what an earlier start put there alone', () => {
		const home = ensureCodexHome(storage);
		fs.writeFileSync(path.join(home, 'marker'), 'kept');

		expect(ensureCodexHome(storage)).toBe(home);
		expect(fs.readFileSync(path.join(home, 'marker'), 'utf8')).toBe('kept');
	});
});
