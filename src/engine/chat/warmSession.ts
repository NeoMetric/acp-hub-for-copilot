/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter } from '../../core/adapter';
import type { AcpMcpHttpServer, AgentSession } from '../acp/protocol';
import type { AgentApi, BridgeEndpoint, ToolBridge } from './types';

/** The ACP server entry that points a session at the host's tool bridge. */
export function bridgeServer(endpoint: BridgeEndpoint): AcpMcpHttpServer {
	return {
		type: 'http' as const,
		name: 'vscode',
		url: endpoint.url,
		headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }],
	};
}

export interface WarmSessionHost {
	adapter: AgentAdapter;
	bridge: ToolBridge;
	agentClient(): Promise<AgentApi>;
	/** Where the warm session is rooted. */
	cwd(): string;
	/** Called once the session is open, so the idle sweep starts watching it. */
	opened(): void;
}

/**
 * The one session per agent that reads the model list and answers the agent's
 * own commands. It offers no tools and is closed once it has been unused for a
 * while.
 */
export class WarmSession {

	private session: AgentSession | undefined;
	private creation: Promise<AgentSession> | undefined;
	private agentClient: AgentApi | undefined;
	private usedAtMs = 0;
	/** The bridge registration behind the session, released with it. */
	private endpoint: BridgeEndpoint | undefined;

	constructor(private readonly host: WarmSessionHost) { }

	/** The open session, if there is one. */
	get current(): AgentSession | undefined {
		return this.session;
	}

	/** The agent process the warm session lives in, once it has opened. */
	get client(): AgentApi | undefined {
		return this.agentClient;
	}

	get isOpening(): boolean {
		return this.creation !== undefined;
	}

	get usedAt(): number {
		return this.usedAtMs;
	}

	touch(): void {
		this.usedAtMs = Date.now();
	}

	async ensure(): Promise<AgentSession> {
		this.touch();
		if (this.session) {
			return this.session;
		}
		if (!this.creation) {
			this.creation = this.open()
				.then(session => {
					this.session = session;
					this.touch();
					this.host.opened();
					return session;
				})
				.finally(() => {
					this.creation = undefined;
				});
		}
		return this.creation;
	}

	/**
	 * Some agents need the session to declare the bridge, because their own
	 * configuration names that server and fails `session/new` when a session
	 * leaves the entry out.
	 */
	private async open(): Promise<AgentSession> {
		const agent = await this.host.agentClient();
		const cwd = this.host.cwd();
		if (!this.host.adapter.declaresBridgeOnModelLookup) {
			const session = await agent.createSession({ cwd, mcpServers: [], ephemeral: true });
			this.agentClient = agent;
			return session;
		}
		const endpoint = await this.host.bridge.registerSession([], async () => undefined);
		try {
			const session = await agent.createSession({ cwd, mcpServers: [bridgeServer(endpoint)], ephemeral: true });
			this.endpoint = endpoint;
			this.agentClient = agent;
			return session;
		} catch (error) {
			this.host.bridge.unregisterSession(endpoint.token);
			throw error;
		}
	}

	/** Drops the session and the bridge registration it held. */
	release(): void {
		if (this.endpoint) {
			this.host.bridge.unregisterSession(this.endpoint.token);
			this.endpoint = undefined;
		}
		this.session = undefined;
		this.creation = undefined;
		this.agentClient = undefined;
	}
}
