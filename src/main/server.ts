/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHeadlessComposition } from '../composition/headless';
import type { CancellationToken } from '../engine/acp/emitter';
import type { ToolBridge } from '../engine/chat/types';
import { McpBridge, type McpToolResult } from '../engine/mcp/bridge';
import type { Part } from '../engine/model/chat';
import { storageRoot } from '../engine/store/paths';
import { stderrLog } from '../hosts/http/host';
import { createServer } from '../hosts/http/server';

/** The port the server listens on when the operator names none. */
const DEFAULT_PORT = 8791;

/** How long a closing server waits for requests that never end, such as a stream no client reads. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * The loopback bridge as the engine sees it. The tools and the results are
 * already the engine's own neutral ones; only the cancellation is translated,
 * and the parts are handed over in the shape the agent reads.
 */
function toolBridgeOf(bridge: McpBridge): ToolBridge {
	return {
		registerSession: (tools, execute, options) => bridge.registerSession(
			tools,
			async (name, input, token): Promise<McpToolResult | undefined> => {
				const result = await execute(name, input, signalOf(token));
				return result && { content: result.content.map(toBridgePart), isError: result.isError };
			},
			options,
		),
		updateTools: (token, tools) => bridge.updateTools(token, tools),
		unregisterSession: token => bridge.unregisterSession(token),
	};
}

/** A neutral part as the bridge hands it to the agent: its text, or an image's bytes. */
function toBridgePart(part: Part): unknown {
	return part.type === 'text' ? part.text : part.type === 'image' ? { data: part.data, mimeType: part.mimeType } : part;
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

/** The port `ACP_HUB_PORT` names, or the default; a value that is not a port is a start-up mistake. */
function portOf(value: string | undefined): number {
	const text = value?.trim();
	if (!text) {
		return DEFAULT_PORT;
	}
	const port = Number(text);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`ACP_HUB_PORT must be a port number, not "${text}".`);
	}
	return port;
}

/**
 * Starts the headless gateway: the engine over the store, the HTTP surface, the
 * loopback binding, and the shutdown that stops the agents on the way out.
 */
export function startServer(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createServer> {
	const port = portOf(env.ACP_HUB_PORT);
	const token = env.ACP_HUB_TOKEN?.trim() || undefined;
	// The client runs the tools a turn asks for, so the loopback bridge only
	// relays the calls; a chat's session keeps the call parked for the re-post.
	const bridge = new McpBridge(stderrLog);
	// The same root the extension uses, so an agent installed in one gateway is installed in both.
	const composition = createHeadlessComposition({ root: storageRoot(env), bridge: toolBridgeOf(bridge), log: stderrLog });
	const server = createServer({ composition, token, page: { control: composition.control } });

	server.listen(port, '127.0.0.1', () => {
		const address = server.address();
		const bound = typeof address === 'object' && address !== null ? address.port : port;
		stderrLog(`ACP Hub server listening on http://127.0.0.1:${bound}${token ? ' with a bearer token' : ''}.`);
	});
	server.on('error', error => {
		stderrLog(`The server stopped: ${error.message}`, 'error');
		void composition.close().finally(() => {
			bridge.dispose();
			process.exit(1);
		});
	});

	let stopping = false;
	const stop = (signal: NodeJS.Signals): void => {
		if (stopping) {
			return;
		}
		stopping = true;
		stderrLog(`Received ${signal}; closing the server.`);
		server.close(() => {
			void composition.close()
				.catch(error => stderrLog(`Could not stop every agent: ${error instanceof Error ? error.message : String(error)}`, 'warn'))
				.finally(() => {
					bridge.dispose();
					process.exit(0);
				});
		});
		server.closeIdleConnections();
		// A request that never ends, such as a stream no client reads, must not keep the process alive.
		setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);

	return server;
}

startServer();
