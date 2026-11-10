/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentChange } from '../acp/agentClient';
import type { Log } from '../ports/host';
import type { AgentApi } from './types';

/** The agent process, and the chats whose sessions live in it. */
export interface AgentProcess {
	/** The folder the process was started in, which no chat's folder decides. */
	readonly root: string;
	readonly client: AgentApi;
	/** The chat keys served by this process. */
	readonly sessions: Set<string>;
	/** When a chat last used the process, for the idle shutdown. */
	lastUsed: number;
	/** Stops listening to the process's own changes; set once it is acquired. */
	listener?: { dispose(): void };
}

export interface AgentProcessesDeps {
	/** The folder the process runs in, read when it starts. */
	root(): string;
	/** Starts the process of a root. */
	create(root: string): AgentApi;
	/** The process reported that it restarted, exited, or was stopped for being idle. */
	changed?(entry: AgentProcess, change: AgentChange): void;
	readonly log: Log;
}

/**
 * The one process an agent runs in: started by the first chat or the first read
 * of its models, kept for every chat whatever folder it belongs to, and stopped
 * only by the idle shutdown or the host. Its sessions carry the chat's real
 * folders, so the folder the process runs in decides nothing a chat sees.
 */
export class AgentProcesses {

	private entry: AgentProcess | undefined;

	constructor(private readonly deps: AgentProcessesDeps) { }

	/** The process, once it has been started. */
	get current(): AgentProcess | undefined {
		return this.entry;
	}

	/** Whether the process is running or on its way up. */
	anyRunning(): boolean {
		return this.entry?.client.isRunning === true;
	}

	/** Whether the process refused a request for lack of credentials. */
	anySignInRequired(): boolean {
		return this.entry?.client.requiresSignIn === true;
	}

	/** The process, started the first time a chat or the model list asks for it. */
	acquire(): AgentProcess {
		if (this.entry) {
			this.touch(this.entry);
			return this.entry;
		}
		const root = this.deps.root();
		const client = this.deps.create(root);
		const entry: AgentProcess = { root, client, sessions: new Set(), lastUsed: Date.now() };
		entry.listener = client.onDidChange(change => this.deps.changed?.(entry, change));
		this.entry = entry;
		this.deps.log(`Started the agent in ${root} for every chat.`, 'debug');
		return entry;
	}

	/** Marks the process as the one used now. */
	touch(entry: AgentProcess): void {
		entry.lastUsed = Date.now();
	}

	/** Records that a chat's session lives in this process. */
	own(client: AgentApi, key: string): void {
		if (this.entry?.client === client) {
			this.entry.sessions.add(key);
		}
	}

	/** The process that owns a client, if it is the one running. */
	entryOf(client: AgentApi): AgentProcess | undefined {
		return this.entry?.client === client ? this.entry : undefined;
	}

	/** Forgets a chat. */
	release(key: string): void {
		const entry = this.entry;
		if (entry?.sessions.delete(key)) {
			entry.lastUsed = Date.now();
		}
	}

	/** Stops the process now, without waiting for the agent to answer. */
	disposeAll(): void {
		const entry = this.entry;
		if (!entry) {
			return;
		}
		this.entry = undefined;
		entry.listener?.dispose();
		entry.client.dispose();
	}
}
