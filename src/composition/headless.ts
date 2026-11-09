/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { AgentAdapter, AgentSettings, LaunchContext } from '../core/adapter';
import { ADAPTERS } from '../core/agents';
import { findInstalled } from '../core/installers';
import { readAgentSettings, settingKey } from '../core/settings';
import { ChatService } from '../engine/chat/ChatService';
import type { ToolBridge } from '../engine/chat/types';
import type { HostPort, Log } from '../engine/ports/host';
import { defaultWorkspaceOf } from '../hosts/http/config';
import { createHeadlessHost, stderrLog } from '../hosts/http/host';

/** What the headless gateway needs to exist. */
export interface HeadlessCompositionOptions {
	/** The store root: `config.json`, `state.json`, `secrets.json` and `agents/<id>` live here. */
	readonly root: string;
	/**
	 * The loopback MCP bridge the request's tools reach the HTTP client through.
	 * The extension's `McpBridge` speaks in VS Code's message parts and cannot be
	 * built outside it, so the server supplies this one.
	 */
	readonly bridge: ToolBridge;
	/** Where the host tells what it does; the server's stderr by default. */
	readonly log?: Log;
	/** Where the adapters' npm manifests are; the working directory by default. */
	readonly extensionDir?: string;
}

/** One host, the adapters it can drive, and the chat use case of each. */
export interface HeadlessComposition {
	readonly host: HostPort;
	readonly adapters: readonly AgentAdapter[];
	/** The service of one agent, by the id the registry gives it. */
	serviceOf(agentId: string): ChatService | undefined;
	/** Stops every agent and releases the sessions of every chat. */
	close(): Promise<void>;
}

/** The engine wired for a process with no window: the same agents and chats the extension serves. */
export function createHeadlessComposition(options: HeadlessCompositionOptions): HeadlessComposition {
	const root = path.resolve(options.root);
	const log = options.log ?? stderrLog;
	const extensionDir = options.extensionDir ?? process.cwd();
	const host = createHeadlessHost({ root, log });
	const agentsDir = path.join(root, 'agents');

	const settingsOf = (adapter: AgentAdapter): AgentSettings => {
		const result = readAgentSettings(adapter, host.settings);
		for (const warning of result.warnings) {
			log(`${adapter.id}: ${warning}`, 'warn');
		}
		return result.values;
	};

	/** The folder of the window the extension would have; a request that names another folder is rooted in it instead. */
	const workspaceFolder = (): string => defaultWorkspaceOf(host.settings) ?? process.cwd();

	const resolveLaunch = async (adapter: AgentAdapter): Promise<LaunchContext | undefined> => {
		const settings = settingsOf(adapter);
		const installed = await findInstalled(adapter, {
			storageDir: agentsDir,
			extensionDir,
			settings,
			log,
			progress: message => log(`${adapter.id}: ${message}`),
		});
		if (!installed) {
			return undefined;
		}
		return {
			...installed,
			storageDir: path.join(agentsDir, adapter.id),
			settings,
			apiKey: await host.secrets.get(adapter.id),
			workspaceFolder: workspaceFolder(),
		};
	};

	const services = new Map<string, ChatService>();
	for (const adapter of ADAPTERS) {
		services.set(adapter.id, new ChatService({
			adapter,
			host,
			bridge: options.bridge,
			resolveLaunch: () => resolveLaunch(adapter),
			isEnabled: () => host.settings.get<boolean>(settingKey(adapter.id, 'enabled')) !== false,
		}));
	}

	return {
		host,
		adapters: ADAPTERS,
		serviceOf: agentId => services.get(agentId),
		close: async () => {
			await Promise.all([...services.values()].map(service => service.close()));
		},
	};
}
