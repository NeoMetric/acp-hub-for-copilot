/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { MAX_STREAMS_PER_SESSION, McpBridge, type McpServerEndpoint } from '../../../src/engine/mcp/bridge';
import type { ToolDef } from '../../../src/engine/model/chat';

const NO_LOG = (): void => undefined;

const tools = [{ name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object' } }] as unknown as ToolDef[];

/** Opens one notification stream and reads the comment the bridge writes first. */
async function openStream(endpoint: McpServerEndpoint): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	const response = await fetch(endpoint.url, { headers: { authorization: `Bearer ${endpoint.token}` } });
	expect(response.status).toBe(200);
	const reader = response.body!.getReader();
	await reader.read();
	return reader;
}

/** Reads a stream to its end, failing the test rather than hanging when it never ends. */
async function ends(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<boolean>(resolve => {
		timer = setTimeout(() => resolve(false), 2_000);
		timer.unref();
	});
	const reading = (async (): Promise<boolean> => {
		for (; ;) {
			const { done } = await reader.read();
			if (done) {
				return true;
			}
		}
	})();
	try {
		return await Promise.race([reading, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

describe('the streams of a session', () => {
	it('closes the oldest one when a session opens more than it keeps', async () => {
		const bridge = new McpBridge(NO_LOG, 60_000);
		const endpoint = await bridge.registerSession(tools, async () => undefined);
		try {
			const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
			for (let index = 0; index <= MAX_STREAMS_PER_SESSION; index++) {
				readers.push(await openStream(endpoint));
			}

			expect(bridge.openStreams).toBe(MAX_STREAMS_PER_SESSION);
			expect(bridge.activeHeartbeats).toBe(MAX_STREAMS_PER_SESSION);
			// The stream opened first made room for the one opened last.
			await expect(ends(readers[0])).resolves.toBe(true);

			for (const reader of readers.slice(1)) {
				await reader.cancel();
			}
		} finally {
			bridge.dispose();
		}
	});

	it('drains every stream and heartbeat and stops the server', async () => {
		const bridge = new McpBridge(NO_LOG, 60_000);
		const endpoint = await bridge.registerSession(tools, async () => undefined);
		try {
			const readers = [await openStream(endpoint), await openStream(endpoint), await openStream(endpoint)];
			expect(bridge.activeHeartbeats).toBe(3);

			bridge.drain();

			expect(bridge.activeHeartbeats).toBe(0);
			expect(bridge.openStreams).toBe(0);
			for (const reader of readers) {
				await expect(ends(reader)).resolves.toBe(true);
			}
			await expect(fetch(endpoint.url, { method: 'POST', body: '{}' })).rejects.toThrow();
		} finally {
			bridge.dispose();
		}
	});
});
