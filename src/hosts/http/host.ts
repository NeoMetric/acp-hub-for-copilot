/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { textOf } from '../../engine/chat/messages';
import type { ChatMessage, ChatRequest } from '../../engine/model/chat';
import type { ChatIdentity, HostPort, Log } from '../../engine/ports/host';
import type { ConfigReader } from '../../engine/ports/state';
import { createFileStore } from '../../engine/store/fileStore';
import { defaultWorkspaceOf, loadConfig } from './config';

/** The header a client names its chat with; a client that sends none gets a name from its opening. */
export const CHAT_ID_HEADER = 'x-chat-id';

/** The header a client names the folder its chat works in with. */
export const CWD_HEADER = 'x-acp-cwd';

/**
 * How long a chat's client has to return the result of a tool call. An agent
 * whose adapter names no wait leaves the engine's own wait unbounded, so a
 * client that never comes back would park the call for as long as the process
 * lives.
 */
export const DEFAULT_TOOL_CALL_WAIT_MS = 120_000;

/** Writes one message to the server's stderr, which is where a headless host tells what it does. */
export const stderrLog: Log = (message, level = 'info') => {
	process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
};

/** What a request's headers said, which its neutral request cannot hold. */
export interface RequestHeaders {
	readonly chatId?: string;
	readonly cwd?: string;
}

/**
 * The headers of each request, beside it as the VS Code host keeps what the
 * workbench sent: the engine hands the host a neutral request and the server is
 * the only part that saw the wire.
 */
const HEADERS = new WeakMap<ChatRequest, RequestHeaders>();

/** Records what the headers said about `request`, so the host can name its chat. */
export function rememberHeaders(request: ChatRequest, headers: RequestHeaders): void {
	HEADERS.set(request, headers);
}

export interface HeadlessHostOptions {
	/** The store the host keeps and the agents are installed in. */
	readonly root: string;
	/** Where the host tells what it does; stderr by default. */
	readonly log?: Log;
}

/** The engine's host, for a process with no window and no workbench. */
export function createHeadlessHost(options: HeadlessHostOptions): HostPort {
	const root = path.resolve(options.root);
	const log = options.log ?? stderrLog;
	fs.mkdirSync(root, { recursive: true });

	const settings = loadConfig(root, log);
	const { state, secrets } = createFileStore(root);

	return {
		log,
		state,
		secrets,
		settings,
		storageRoot: root,
		chatIdentity: request => identityOf(request, settings),
		guidanceOf: request => request.systemGuidance,
		// The host writes no sections of its own into the text the engine forwards.
		stripHostSections: text => text,
		chatWideContextOf: () => undefined,
		// The engine never asks this: it hands a tool call to the response that is
		// open, and this host keeps that call in `ToolCallParking` until the client
		// re-posts its result. A call with no response to carry it is refused by
		// the bridge, so nothing can reach a host-side tool runner.
		executeTool: () => {
			throw new Error('executeTool is not used by this host: the HTTP client runs tool calls and re-posts their results.');
		},
		ui: {
			requestSignIn: agentId => log(`${agentId} needs credentials; sign in through the control page.`, 'warn'),
			notify: async message => {
				log(message);
				return undefined;
			},
			openExternal: async url => {
				log(`Open ${url}`);
			},
		},
	};
}

/**
 * The chat a request belongs to. A client that names its chat keeps the name;
 * every other chat is named by the folder it works in and its opening words, so
 * a stock OpenAI client that re-posts the same conversation finds it again.
 */
function identityOf(request: ChatRequest, settings: ConfigReader): ChatIdentity {
	const headers = HEADERS.get(request);
	const cwd = folderOf(request, headers, settings);
	const opening = openingOf(request.messages);
	return {
		id: namedChatId(request, headers) ?? fingerprintOf(cwd, opening),
		cwd,
		// A request carries one folder, which the engine takes as where the agent is rooted.
		workspaceFolders: [],
		label: labelOf(opening),
	};
}

function namedChatId(request: ChatRequest, headers: RequestHeaders | undefined): string | undefined {
	return trimmed(headers?.chatId) ?? trimmed(request.chatId);
}

function folderOf(request: ChatRequest, headers: RequestHeaders | undefined, settings: ConfigReader): string {
	return trimmed(headers?.cwd) ?? trimmed(request.cwd) ?? defaultWorkspaceOf(settings) ?? process.cwd();
}

/** The first thing the user said, which names the chat and seeds its fingerprint. */
function openingOf(messages: readonly ChatMessage[]): string {
	const first = messages.find(message => message.role === 'user');
	return first ? textOf(first).trim() : '';
}

function labelOf(opening: string): string | undefined {
	if (opening === '') {
		return undefined;
	}
	return opening.length > 40 ? `${opening.slice(0, 39)}…` : opening;
}

function fingerprintOf(cwd: string, opening: string): string {
	return createHash('sha1').update(`${cwd}\n${opening}`).digest('hex').slice(0, 12);
}

function trimmed(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

/** A tool call a chat's client is running, as the response that carried it named it. */
export interface ParkedToolCall {
	readonly callId: string;
	readonly name: string;
}

/**
 * The tool calls the clients of each chat are running.
 *
 * The engine hands a call to the response that is open and holds it until a
 * later request brings the result back. This host cannot run the tool itself,
 * so it remembers each call to answer two questions: may this chat settle that
 * call, and has the client waited too long? A call is filed under its chat as
 * well as its id, so two chats cannot settle each other's calls, and one the
 * client never answers is failed instead of staying parked in the engine.
 */
export class ToolCallParking {

	/** The timers of each chat's calls, by call id. */
	private readonly chats = new Map<string, Map<string, NodeJS.Timeout>>();

	constructor(private readonly waitMs: number, private readonly log: Log) { }

	/** Keeps `call` until the client returns its result; `fail` runs if it does not in time. */
	park(chatId: string, call: ParkedToolCall, fail: () => void): void {
		this.forget(chatId, call.callId);
		const calls = this.chats.get(chatId) ?? new Map<string, NodeJS.Timeout>();
		this.chats.set(chatId, calls);
		const timer = setTimeout(() => {
			this.forget(chatId, call.callId);
			this.log(`Chat ${chatId} did not answer tool ${call.name} (${call.callId}) within ${Math.round(this.waitMs / 1000)}s; failing the call.`, 'warn');
			fail();
		}, this.waitMs);
		timer.unref();
		calls.set(call.callId, timer);
	}

	/** Whether the chat still holds the call, so a result for it may be taken. */
	has(chatId: string, callId: string): boolean {
		return this.chats.get(chatId)?.has(callId) === true;
	}

	/** Takes the call a request answers, so its timer cannot fail a call already settled. */
	take(chatId: string, callId: string): boolean {
		return this.forget(chatId, callId);
	}

	/** Forgets every call of one chat, e.g. when its client disconnects and no result can come. */
	clear(chatId: string): void {
		const calls = this.chats.get(chatId);
		if (!calls) {
			return;
		}
		for (const timer of calls.values()) {
			clearTimeout(timer);
		}
		this.chats.delete(chatId);
	}

	/** Forgets every call, e.g. when the server stops and no client can answer any more. */
	dispose(): void {
		for (const calls of this.chats.values()) {
			for (const timer of calls.values()) {
				clearTimeout(timer);
			}
		}
		this.chats.clear();
	}

	private forget(chatId: string, callId: string): boolean {
		const calls = this.chats.get(chatId);
		const timer = calls?.get(callId);
		if (!calls || timer === undefined) {
			return false;
		}
		clearTimeout(timer);
		calls.delete(callId);
		if (calls.size === 0) {
			this.chats.delete(chatId);
		}
		return true;
	}
}
