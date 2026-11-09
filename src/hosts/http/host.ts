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
import type { ConfigReader, SecretStore, StateStore } from '../../engine/ports/state';
import { defaultWorkspaceOf, loadConfig } from './config';

/** The header a client names its chat with; a client that sends none gets a name from its opening. */
export const CHAT_ID_HEADER = 'x-chat-id';

/** The header a client names the folder its chat works in with. */
export const CWD_HEADER = 'x-acp-cwd';

const STATE_FILE = 'state.json';
const SECRETS_FILE = 'secrets.json';
/** How the extension names an agent's key in its own secret storage; the file keeps the same name. */
const SECRET_PREFIX = 'acpHub.apiKey.';

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
	const state = new FileStateStore(path.join(root, STATE_FILE), log);
	const secrets = new FileSecretStore(path.join(root, SECRETS_FILE), log);

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
		// The HTTP client runs the tools, and a later step parks the call until it
		// re-posts the result; nothing reaches the host's own tool running.
		executeTool: () => {
			throw new Error('executeTool is not used by this host.');
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

/** Every write replaces a whole JSON document, through a temp file in the same folder. */
let tempSeq = 0;

async function writeAtomic(file: string, value: unknown, mode?: number): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${++tempSeq}.tmp`;
	try {
		await fs.promises.writeFile(temp, `${JSON.stringify(value, undefined, '\t')}\n`, { encoding: 'utf8', mode });
		await fs.promises.rename(temp, file);
	} catch (error) {
		await fs.promises.rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

function readJsonObject(file: string, log: Log): Record<string, unknown> {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			log(`Could not read ${file} (${messageOf(error)}); starting empty.`, 'warn');
		}
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		log(`${file} does not hold a JSON object; starting empty.`, 'warn');
	} catch (error) {
		log(`Could not parse ${file} (${messageOf(error)}); starting empty.`, 'warn');
	}
	return {};
}

/** The engine's key/value state, as one JSON document under the store root. */
class FileStateStore implements StateStore {

	private readonly values: Record<string, unknown>;
	private pending: Promise<void> = Promise.resolve();

	constructor(private readonly file: string, log: Log) {
		this.values = readJsonObject(file, log);
	}

	get<T>(key: string): T | undefined {
		return this.values[key] as T | undefined;
	}

	keys(): readonly string[] {
		return Object.keys(this.values);
	}

	update(key: string, value: unknown): Promise<void> {
		this.values[key] = value;
		return this.save();
	}

	/** Queues the write, so two updates never interleave their temp files and renames. */
	private save(): Promise<void> {
		const next = this.pending.catch(() => undefined).then(() => writeAtomic(this.file, this.values));
		this.pending = next.catch(() => undefined);
		return next;
	}
}

/** The agents' keys, in a file only the owner's account can read. */
class FileSecretStore implements SecretStore {

	private readonly values: Record<string, unknown>;
	private pending: Promise<void> = Promise.resolve();

	constructor(private readonly file: string, log: Log) {
		this.values = readJsonObject(file, log);
	}

	async get(id: string): Promise<string | undefined> {
		await this.pending;
		const value = this.values[`${SECRET_PREFIX}${id}`];
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}

	async set(id: string, value: string): Promise<void> {
		this.values[`${SECRET_PREFIX}${id}`] = value;
		await this.save();
	}

	async delete(id: string): Promise<void> {
		delete this.values[`${SECRET_PREFIX}${id}`];
		await this.save();
	}

	private save(): Promise<void> {
		const next = this.pending.catch(() => undefined).then(() => writeAtomic(this.file, this.values, 0o600));
		this.pending = next.catch(() => undefined);
		return next;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
