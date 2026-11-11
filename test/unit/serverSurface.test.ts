/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/hosts/http/config';
import { createServerSurface } from '../../src/main/serverSurface';

const roots: string[] = [];

function surfaceOf(options: { port?: number; env?: NodeJS.ProcessEnv; stop?: () => void; token?: string } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-surface-'));
	roots.push(root);
	const config = loadConfig(root);
	const surface = createServerSurface({
		config,
		token: options.token ?? 'tok',
		env: options.env ?? {},
		port: () => options.port ?? 8791,
		stop: options.stop ?? (() => undefined),
	});
	return { surface, config, root };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('the server surface', () => {
	it('describes the running server with a token link', () => {
		const { surface } = surfaceOf({ port: 8791, token: 'a b/c' });

		expect(surface.view()).toEqual({
			port: 8791,
			savedPort: 8791,
			url: 'http://127.0.0.1:8791/?token=a%20b%2Fc',
			portFromEnv: false,
			alive: true,
		});
	});

	it('saves the port to config.json and reports it apart from the running one', async () => {
		const { surface, config } = surfaceOf({ port: 8791 });

		await surface.setPort(9100);

		expect(config.get('server.port')).toBe(9100);
		expect(surface.view()).toMatchObject({ port: 8791, savedPort: 9100 });
	});

	it('says when ACP_HUB_PORT names the port', () => {
		expect(surfaceOf({ env: { ACP_HUB_PORT: '9000' } }).surface.view().portFromEnv).toBe(true);
		expect(surfaceOf({ env: { ACP_HUB_PORT: '  ' } }).surface.view().portFromEnv).toBe(false);
	});

	it('stops the server on restart', () => {
		const stop = vi.fn();
		surfaceOf({ stop }).surface.restart();
		expect(stop).toHaveBeenCalledTimes(1);
	});
});
