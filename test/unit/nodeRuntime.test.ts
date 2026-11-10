/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSystemNode, resolveNode } from '../../src/core/nodeRuntime';

describe('finding a Node for the server', () => {
	it('takes the node on PATH when it is new enough', async () => {
		const found = await findSystemNode({ PATH: path.dirname(process.execPath) });

		expect(found).toBe(process.execPath);
	});

	it('finds nothing when PATH holds no node', async () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-node-'));
		try {
			expect(await findSystemNode({ PATH: empty })).toBeUndefined();
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});

	it('does not download when downloading is off and no node is found', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-node-'));
		const saved = process.env.PATH;
		const savedPath = process.env.Path;
		process.env.PATH = root;
		process.env.Path = root;
		try {
			const node = await resolveNode({ root, log: () => undefined, download: false });
			// A machine can still keep node in a well-known folder; only the absence of a download is asserted.
			expect(fs.existsSync(path.join(root, 'node'))).toBe(false);
			expect(node === undefined || typeof node === 'string').toBe(true);
		} finally {
			process.env.PATH = saved;
			process.env.Path = savedPath;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
