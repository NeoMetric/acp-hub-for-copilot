/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureToken, readToken, serverToken, tokenFileOf } from '../../src/main/token';

const roots: string[] = [];

/** A store root of its own for one test, removed afterwards. */
function storeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-token-'));
	roots.push(root);
	return root;
}

/** An environment that names no token. */
const NO_ENV: NodeJS.ProcessEnv = {};

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

describe('the server token', () => {
	it('lives in the store root both gateways share', () => {
		const root = storeRoot();

		expect(tokenFileOf(root)).toBe(path.join(path.resolve(root), 'server.token'));
	});

	it('readToken prefers the environment over the file', () => {
		const root = storeRoot();
		const fromFile = ensureToken(root);

		expect(readToken(root, { ACP_HUB_TOKEN: 'from-the-environment' })).toBe('from-the-environment');
		expect(readToken(root, NO_ENV)).toBe(fromFile);
	});

	it('ensureToken creates the file once and returns the same token twice', () => {
		const root = storeRoot();

		const first = ensureToken(root);
		const second = ensureToken(root);

		expect(second).toBe(first);
		expect(first).toMatch(/^[0-9a-f]{48}$/);
		expect(fs.readFileSync(tokenFileOf(root), 'utf8').trim()).toBe(first);
		expect(readToken(root, NO_ENV)).toBe(first);
	});

	it('readToken is undefined with neither', () => {
		const root = storeRoot();

		expect(readToken(root, NO_ENV)).toBeUndefined();
	});

	it('a server on a fresh root makes the token it then requires', () => {
		const root = storeRoot();
		expect(readToken(root, NO_ENV)).toBeUndefined();

		const token = serverToken(root, NO_ENV);

		expect(token).toMatch(/^[0-9a-f]{48}$/);
		expect(fs.readFileSync(tokenFileOf(root), 'utf8').trim()).toBe(token);
		expect(readToken(root, NO_ENV), 'a client must present the token the server made').toBe(token);
		expect(serverToken(root, NO_ENV)).toBe(token);
	});

	it('a server uses the operator\'s token without making a file', () => {
		const root = storeRoot();

		expect(serverToken(root, { ACP_HUB_TOKEN: 'from-the-environment' })).toBe('from-the-environment');
		expect(fs.existsSync(tokenFileOf(root))).toBe(false);
	});

	it('a blank environment variable does not hide the file', () => {
		const root = storeRoot();
		const fromFile = ensureToken(root);

		expect(readToken(root, { ACP_HUB_TOKEN: '   ' })).toBe(fromFile);
	});
});
