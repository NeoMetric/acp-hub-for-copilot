/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The file the bearer token is kept in, below the store root both gateways share. */
const TOKEN_FILE = 'server.token';

/**
 * Where the token lives: `<root>/server.token`. Both the server and the window
 * that starts it derive the path from the same root, so neither invents one.
 */
export function tokenFileOf(root: string): string {
	return path.join(path.resolve(root), TOKEN_FILE);
}

/**
 * The token to send the server: `ACP_HUB_TOKEN` when the operator names one,
 * else the stored file's contents, else nothing — which is how a server that
 * wants no token is reached.
 */
export function readToken(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env.ACP_HUB_TOKEN?.trim();
	if (configured) {
		return configured;
	}
	try {
		return fs.readFileSync(tokenFileOf(root), 'utf8').trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * The token the server on `root` requires, made once and kept: a file created
 * with `wx` is the lock, so two windows starting at the same moment agree on
 * one token.
 */
export function ensureToken(root: string): string {
	const file = tokenFileOf(root);
	const existing = readToken(root, {});
	if (existing) {
		return existing;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const token = randomBytes(24).toString('hex');
	try {
		fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		return token;
	} catch (error) {
		// Another process made the file first; its token is the one the server reads.
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
		const raced = readToken(root, {});
		if (!raced) {
			throw new Error(`The token file ${file} exists but is empty.`, { cause: error });
		}
		return raced;
	}
}

/**
 * The token the server itself requires: the operator's, the stored one, or one
 * made now — so a server started by hand never serves without a token.
 */
export function serverToken(root: string, env: NodeJS.ProcessEnv = process.env): string {
	return readToken(root, env) ?? ensureToken(root);
}
