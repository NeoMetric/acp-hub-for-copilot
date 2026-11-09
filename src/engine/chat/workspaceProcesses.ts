/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentChange } from '../acp/agentClient';
import type { ChatIdentity, Log } from '../ports/host';
import type { AgentApi } from './types';

/** How many agent processes one service keeps at once; the least recently used one is stopped beyond this. */
export const MAX_WORKSPACE_PROCESSES = 4;

/** One agent process, and the chats whose sessions live in it. */
export interface WorkspaceProcess {
	/** `${agentId}#${root}`, unique among the processes of one service. */
	readonly key: string;
	/** The folder the process was started in. */
	readonly root: string;
	readonly client: AgentApi;
	/** The chat keys served by this process. */
	readonly sessions: Set<string>;
	/** When a chat last used the process, for the LRU bound and the idle shutdown. */
	lastUsed: number;
	/** Stops listening to the process's own changes; set once it is acquired. */
	listener?: { dispose(): void };
}

export interface WorkspaceProcessesDeps {
	/** The agent every process belongs to, which names it beside its workspace. */
	readonly agentId: string;
	/** Starts the process of a root; called once for each new root. */
	create(root: string): AgentApi;
	/** Lets go of a process's chats before its process is stopped. */
	close(entry: WorkspaceProcess): void | Promise<void>;
	/** The process reported that it restarted, exited, or was stopped for being idle. */
	changed?(entry: WorkspaceProcess, change: AgentChange): void;
	readonly log: Log;
	/** How many processes to keep; {@link MAX_WORKSPACE_PROCESSES} when absent. */
	readonly capacity?: number;
}

/**
 * The agent processes of one agent, one per workspace root: a chat in another
 * repository gets a process rooted there instead of a session in a process
 * started somewhere else. Processes beyond the bound are stopped least recently
 * used first, and their chats resume from their stored conversations.
 */
export class WorkspaceProcesses {

	private readonly entries = new Map<string, WorkspaceProcess>();

	constructor(private readonly deps: WorkspaceProcessesDeps) { }

	get capacity(): number {
		return Math.max(1, this.deps.capacity ?? MAX_WORKSPACE_PROCESSES);
	}

	get size(): number {
		return this.entries.size;
	}

	/** The processes in use, least recently used first. */
	list(): WorkspaceProcess[] {
		return [...this.entries.values()];
	}

	/** Whether any process is running or on its way up. */
	anyRunning(): boolean {
		return this.list().some(entry => entry.client.isRunning);
	}

	/** Whether any process refused a request for lack of credentials. */
	anySignInRequired(): boolean {
		return this.list().some(entry => entry.client.requiresSignIn);
	}

	/** The process of a root, if it is open. */
	get(root: string): WorkspaceProcess | undefined {
		return this.entries.get(this.keyOf(root));
	}

	/** The process of a root, started the first time a chat asks for it. */
	async acquire(root: string): Promise<WorkspaceProcess> {
		const existing = this.get(root);
		if (existing) {
			this.touch(existing);
			return existing;
		}
		const client = this.deps.create(root);
		const entry: WorkspaceProcess = { key: this.keyOf(root), root, client, sessions: new Set(), lastUsed: Date.now() };
		entry.listener = client.onDidChange(change => this.deps.changed?.(entry, change));
		this.entries.set(entry.key, entry);
		this.deps.log(`Started the agent in ${root} (${this.entries.size} of ${this.capacity} process(es) kept).`, 'debug');		await this.enforce();
		return entry;
	}

	/** Marks a process as the one used now, so the LRU bound stops the others first. */
	touch(entry: WorkspaceProcess): void {
		entry.lastUsed = Date.now();
		this.entries.delete(entry.key);
		this.entries.set(entry.key, entry);
	}

	/** Records that a chat's session lives in the process that owns `client`. */
	own(client: AgentApi, key: string): void {
		const entry = this.entryOf(client);
		if (entry) {
			entry.sessions.add(key);
		}
	}

	/** The process that owns a client, if it is still open. */
	entryOf(client: AgentApi): WorkspaceProcess | undefined {
		for (const entry of this.entries.values()) {
			if (entry.client === client) {
				return entry;
			}
		}
		return undefined;
	}

	/** Forgets a chat, whichever process held it. */
	release(key: string): void {
		for (const entry of this.entries.values()) {
			if (entry.sessions.delete(key)) {
				entry.lastUsed = Date.now();
			}
		}
	}

	/** Stops every process now, without waiting for the agent to answer. */
	disposeAll(): void {
		for (const entry of this.list()) {
			this.entries.delete(entry.key);
			entry.listener?.dispose();
			entry.client.dispose();
		}
	}

	/** Stops the least recently used processes until the bound holds again. */
	private async enforce(): Promise<void> {
		while (this.entries.size > this.capacity) {
			const oldest = this.entries.values().next().value;
			if (!oldest) {
				return;
			}
			this.entries.delete(oldest.key);
			this.deps.log(`Stopping the agent in ${oldest.root}: it is the least recently used of more than ${this.capacity} process(es).`, 'debug');
			await this.deps.close(oldest);
			oldest.listener?.dispose();
			oldest.client.dispose();
		}
	}

	private keyOf(root: string): string {
		return `${this.deps.agentId}#${root}`;
	}
}

/**
 * The workspace a chat belongs to: the first folder it names, or its own folder
 * when it names none. A drive letter is levelled, as the VS Code host levels the
 * folders it scrapes, so one repository is one root however it is spelled.
 */
export function workspaceRootOf(identity: ChatIdentity): string {
	const first = identity.workspaceFolders.find(folder => folder.trim() !== '');
	return normalizeRoot(first ?? identity.cwd);
}

/** A folder in one spelling: no trailing separator, and a lower-case drive letter. */
export function normalizeRoot(folder: string): string {
	const trimmed = folder.trim();
	const stripped = trimmed.replace(/[\\/]+$/, '');
	const root = stripped === '' || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped;
	return root.replace(/^[A-Z]:/, drive => drive.toLowerCase());
}
