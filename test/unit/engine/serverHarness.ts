/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HeadlessComposition } from '../../../src/composition/headless';
import type { AgentAdapter, LaunchContext, ModelPolicy } from '../../../src/core/adapter';
import type { CancellationToken } from '../../../src/engine/acp/emitter';
import { ChatService } from '../../../src/engine/chat/ChatService';
import type { ToolBridge } from '../../../src/engine/chat/types';
import { McpBridge } from '../../../src/engine/mcp/bridge';
import type { Part } from '../../../src/engine/model/chat';
import { createHeadlessHost, type HeadlessHost } from '../../../src/hosts/http/host';
import { createServer } from '../../../src/hosts/http/server';

export const MOCK_AGENT = path.resolve(__dirname, '..', '..', 'fixtures', 'mock-acp-agent.cjs');
export const NO_LOG = (): void => undefined;

/** The context window the mock agent's models advertise. */
export const MOCK_WINDOW = 200_000;
/** The output share of that window. */
export const MOCK_MAX_OUTPUT = 8_000;

/** How the mock agent's models are described in the picker. */
export const MOCK_POLICY: ModelPolicy = {
	detail: 'Mock ACP',
	familyOf: value => `${value} family`,
	contextWindowOf: () => MOCK_WINDOW,
	maxOutputTokens: MOCK_MAX_OUTPUT,
	effortConfigId: 'effort',
	effortLabel: value => value.charAt(0).toUpperCase() + value.slice(1),
	effortDescription: value => `about ${value}`,
	defaultEffort: levels => levels.includes('medium') ? 'medium' : levels[0],
	fallbackTooltip: name => `The ${name} model of the mock agent.`,
	thinkingDescription: 'How long the model thinks before it answers.',
};

export interface MockAgentOptions {
	/** The id the server publishes the agent under; `mock` by default. */
	readonly id?: string;
	/** What the picker metadata comes from; {@link MOCK_POLICY} by default. */
	readonly modelPolicy?: ModelPolicy;
	/** Extra environment for the agent's process, such as the fixture's mode. */
	readonly env?: Record<string, string>;
	/** What the adapter makes of the models the agent offers, when it does. */
	readonly listModels?: AgentAdapter['listModels'];
}

/** The mock ACP agent, which streams "hello" and ends its turn. */
export function mockAdapter(options: MockAgentOptions = {}): AgentAdapter {
	const id = options.id ?? 'mock';
	return {
		id,
		displayName: id,
		vendor: `acphub-${id}`,
		install: { kind: 'existing-cli', command: 'node' },
		launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: 'normal', ...options.env } }),
		auth: [],
		settings: [],
		modelPolicy: options.modelPolicy ?? MOCK_POLICY,
		systemPrompt: { toolAccess: '', listRequiredArguments: false },
		listModels: options.listModels,
	};
}

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

/** One agent the server serves, and what it launches. */
export interface HarnessAgent {
	readonly adapter: AgentAdapter;
	/** The launch context the host resolves; `undefined` says the agent is not installed. */
	readonly launch?: () => Promise<LaunchContext | undefined>;
}

export interface ServerOptions {
	readonly token?: string;
	readonly toolCallWaitMs?: number;
}

/** A server that is listening, with what the test needs to drive it. */
export interface RunningServer {
	readonly url: string;
	readonly host: HeadlessHost;
	/** The store root the server writes to, removed with the server. */
	readonly root: string;
	/** Records a context window as the engine does when a turn reports one. */
	reportWindow(agentId: string, model: string, size: number): void;
}

const cleanups: Array<() => Promise<void>> = [];

/**
 * Starts the server on a free port over the given agents, with a store root of
 * its own. The mock agent is served by default.
 */
export async function start(agents: HarnessAgent[] = [{ adapter: mockAdapter() }], options: ServerOptions = {}): Promise<RunningServer> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-server-'));
	const host = createHeadlessHost({ root, log: NO_LOG });
	const loopback = new McpBridge(NO_LOG);
	const windows = new Map<string, Map<string, number>>();
	const windowsOf = (agentId: string): Map<string, number> => {
		let reported = windows.get(agentId);
		if (!reported) {
			reported = new Map();
			windows.set(agentId, reported);
		}
		return reported;
	};
	const services = new Map<string, ChatService>();
	for (const { adapter, launch } of agents) {
		services.set(adapter.id, new ChatService({
			adapter,
			host,
			bridge: toolsOver(loopback),
			resolveLaunch: () => launch
				? launch()
				: Promise.resolve({ entryPath: MOCK_AGENT, installDir: '', storageDir: path.join(root, `agent-${adapter.id}`), workspaceFolder: root, settings: {} }),
			refineWindow: (model, size) => { windowsOf(adapter.id).set(model, size); },
		}));
	}
	const composition: HeadlessComposition = {
		host,
		adapters: agents.map(agent => agent.adapter),
		serviceOf: id => services.get(id),
		reportedWindowsOf: agentId => windowsOf(agentId),
		close: async () => { await Promise.all([...services.values()].map(service => service.close())); },
	};
	const server = createServer({ composition, token: options.token, toolCallWaitMs: options.toolCallWaitMs });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	cleanups.push(async () => {
		const closed = new Promise<void>(resolve => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
		await composition.close();
		loopback.dispose();
		try {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch {
			// A mock agent still shutting down can hold the folder on Windows; it is left to the temp folder's own clean-up.
		}
	});
	return {
		url: `http://127.0.0.1:${address.port}`,
		host,
		root,
		reportWindow: (agentId, model, size) => { windowsOf(agentId).set(model, size); },
	};
}

/** Stops every server a test started and forgets it. */
export async function closeServers(): Promise<void> {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
}
