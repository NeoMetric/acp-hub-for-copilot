/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { textOf } from '../../engine/chat/messages';
import type { ChatMessage, ChatRequest } from '../../engine/model/chat';
import { DEFAULT_CHAT_OWNER, type ChatIdentity, type HostPort, type Log } from '../../engine/ports/host';
import type { ConfigReader } from '../../engine/ports/state';
import { createFileStore } from '../../engine/store/fileStore';
import { defaultWorkspaceOf, loadConfig } from './config';
import type { AcpRequestExtras } from './wire';

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

/** What a request's wire said about the chat: the `acp` extras, and the older headers. */
export interface RequestExtras {
	readonly acp?: AcpRequestExtras;
	readonly headers?: RequestHeaders;
}

/**
 * The extras of each request, beside it as the VS Code host keeps what the
 * workbench sent: the engine hands the host a neutral request and the server is
 * the only part that saw the wire.
 *
 * The extras are kept for each message as well as for the request, because the
 * engine asks for the chat's context with a slice of the messages it was given:
 * a slice is a new array, but it holds the same messages.
 */
const EXTRAS = new WeakMap<ChatRequest, RequestExtras>();
const MESSAGE_EXTRAS = new WeakMap<ChatMessage, RequestExtras>();

/** Records what the wire said about `request`, so the host can name its chat. */
export function rememberExtras(request: ChatRequest, extras: RequestExtras): void {
	EXTRAS.set(request, extras);
	for (const message of request.messages) {
		MESSAGE_EXTRAS.set(message, extras);
	}
}

function extrasOf(request: ChatRequest): RequestExtras | undefined {
	return EXTRAS.get(request);
}

/** The extras of a request, found from any of the messages it carried. */
function extrasOfMessages(messages: readonly ChatMessage[]): RequestExtras | undefined {
	for (const message of messages) {
		const extras = MESSAGE_EXTRAS.get(message);
		if (extras) {
			return extras;
		}
	}
	return undefined;
}

export interface HeadlessHostOptions {
	/** The store the host keeps and the agents are installed in. */
	readonly root: string;
	/** Where the host tells what it does; stderr by default. */
	readonly log?: Log;
	/** The client whose chats these are: the token's principal, or `default` when there is none. */
	readonly owner?: string;
}

/** The headless host, which also writes the settings the control page changes. */
export interface HeadlessHost extends HostPort {
	/** Writes one `acpHub.<key>` value into `config.json`. */
	writeSetting(key: string, value: unknown): Promise<void>;
}

/** The engine's host, for a process with no window and no workbench. */
export function createHeadlessHost(options: HeadlessHostOptions): HeadlessHost {
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
		writeSetting: (key, value) => settings.set(key, value),
		chatIdentity: request => identityOf(request, settings, options.owner ?? DEFAULT_CHAT_OWNER),
		// The guidance is the extension's own: it took its persona out before sending, so it is used as it stands.
		guidanceOf: request => extrasOf(request)?.acp?.systemGuidance ?? request.systemGuidance,
		// The host writes no sections of its own into the text the engine forwards.
		stripHostSections: text => text,
		chatWideContextOf: messages => extrasOfMessages(messages)?.acp?.chatContext,
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
 * a stock OpenAI client that re-posts the same conversation finds it again. The
 * `acp` extras name it first, then the headers, then what the request itself says.
 */
function identityOf(request: ChatRequest, settings: ConfigReader, owner: string): ChatIdentity {
	const extras = extrasOf(request);
	const cwd = folderOf(request, extras, settings);
	const opening = openingOf(request.messages);
	return {
		id: namedChatId(request, extras) ?? fingerprintOf(cwd, opening),
		cwd,
		workspaceFolders: extras?.acp?.workspaceFolders ?? [],
		label: trimmed(extras?.acp?.label) ?? labelOf(opening),
		owner,
	};
}

/**
 * The owner a bearer token names: a short, stable label that does not reveal the
 * token, so two servers sharing one store count their quotas apart. A server
 * without a token has one anonymous principal.
 */
export function ownerOfToken(token: string | undefined): string {
	return token === undefined
		? DEFAULT_CHAT_OWNER
		: `bearer:${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;
}

/**
 * The name the chat is listed under. `acp.chatId` names it for its figures and is
 * shared by the sub-agents of one chat; the request's own name is the session key
 * the server derived for the engine, so it names the chat only when the client sent
 * no session key of its own. A chat named nowhere is named by its folder and opening.
 */
function namedChatId(request: ChatRequest, extras: RequestExtras | undefined): string | undefined {
	const own = trimmed(request.chatId);
	const session = trimmed(extras?.acp?.sessionKey);
	return trimmed(extras?.acp?.chatId) ?? trimmed(extras?.headers?.chatId) ?? (session !== undefined && session === own ? undefined : own);
}

function folderOf(request: ChatRequest, extras: RequestExtras | undefined, settings: ConfigReader): string {
	return trimmed(extras?.acp?.cwd) ?? trimmed(extras?.headers?.cwd) ?? trimmed(request.cwd) ?? defaultWorkspaceOf(settings) ?? process.cwd();
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
