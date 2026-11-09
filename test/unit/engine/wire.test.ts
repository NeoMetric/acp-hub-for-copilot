/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeadlessComposition } from '../../../src/composition/headless';
import type { AgentAdapter } from '../../../src/core/adapter';
import type { CancellationToken } from '../../../src/engine/acp/emitter';
import { ChatService } from '../../../src/engine/chat/ChatService';
import type { ToolBridge } from '../../../src/engine/chat/types';
import { McpBridge } from '../../../src/engine/mcp/bridge';
import type { Part } from '../../../src/engine/model/chat';
import { createHeadlessHost } from '../../../src/hosts/http/host';
import { createServer } from '../../../src/hosts/http/server';
import { API_VERSION, SERVER_NAME, type HealthWire } from '../../../src/hosts/http/wire';

const MOCK_AGENT = path.resolve(__dirname, '..', 'fixtures', 'mock-acp-agent.cjs');
const NO_LOG = (): void => undefined;

/** The mock ACP agent, which streams "hello" and ends its turn. */
const adapter: AgentAdapter = {
	id: 'mock',
	displayName: 'Mock',
	vendor: 'acphub-mock',
	install: { kind: 'existing-cli', command: 'node' },
	launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: 'normal' } }),
	auth: [],
	settings: [],
	modelPolicy: {} as AgentAdapter['modelPolicy'],
	systemPrompt: { toolAccess: '', listRequiredArguments: false },
};

/** The engine's loopback bridge as the host sees it: a call reaches the request that owns it. */
function toolsOver(loopback: McpBridge): ToolBridge {
	return {
		registerSession: (tools, execute, options) => loopback.registerSession(tools, async (name, input, token) => {
			const result = await execute(name, input, signalOf(token));
			return result && { content: result.content.map(toBridgePart), isError: result.isError };
		}, options),
		updateTools: (token, tools) => loopback.updateTools(token, tools),
		unregisterSession: token => loopback.unregisterSession(token),
	};
}

/** A neutral part as the bridge hands it to the agent: its text, or an image's bytes. */
function toBridgePart(part: Part): unknown {
	return part.type === 'text' ? part.text : part;
}

/** A cancellation the engine reports as the plain signal the rest of the engine watches. */
function signalOf(token: CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}

const cleanups: Array<() => Promise<void>> = [];

/** Starts the server on a free port over the mock agent, with a store root of its own. */
async function start(): Promise<string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-wire-'));
	const host = createHeadlessHost({ root, log: NO_LOG });
	const loopback = new McpBridge(NO_LOG);
	const service = new ChatService({
		adapter,
		host,
		bridge: toolsOver(loopback),
		resolveLaunch: () => Promise.resolve({ entryPath: MOCK_AGENT, installDir: '', storageDir: path.join(root, 'agent'), workspaceFolder: root, settings: {} }),
	});
	const composition: HeadlessComposition = {
		host,
		adapters: [adapter],
		serviceOf: id => id === adapter.id ? service : undefined,
		close: () => service.close(),
	};
	const server = createServer({ composition });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	cleanups.push(async () => {
		const closed = new Promise<void>(resolve => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
		await composition.close();
		loopback.dispose();
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

describe('the wire contract', () => {
	it('health reports the server identity', async () => {
		const url = await start();

		const response = await fetch(`${url}/health`);

		expect(response.status).toBe(200);
		const body = await response.json() as HealthWire;
		expect(body.name).toBe(SERVER_NAME);
		expect(body.name).toBe('acp-hub');
		expect(body.apiVersion).toBe(API_VERSION);
		expect(typeof body.version).toBe('string');
		expect(body.status).toBe('ok');
		expect(body.openSessions).toBe(0);
		expect(body.agents).toEqual([expect.objectContaining({ id: adapter.id, installed: true, openSessions: 0 })]);
	});
});
