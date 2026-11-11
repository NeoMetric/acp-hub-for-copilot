/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretStore, StateStore } from '../ports/state';

const STATE_FILE = 'state.json';
const SECRETS_FILE = 'secrets.json';

/** The name an agent's key is filed under, which is also the name the extension uses in SecretStorage. */
const SECRET_PREFIX = 'acpHub.apiKey.';

/** How old a lock file may be before another writer treats its owner as gone. */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for a lock; a live owner should hold one for milliseconds. */
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 10;

/** The two stores both gateways share, under one root. */
export interface FileStore {
	readonly state: StateStore;
	readonly secrets: SecretStore;
}

/**
 * The store both gateways read and write: `state.json` for the engine's
 * key/value state and `secrets.json` for the agents' keys. Each is one JSON
 * document, and every write merges one key on top of the newest copy on disk
 * under a lock, so two processes never lose each other's writes.
 */
export function createFileStore(root: string): FileStore {
	const directory = path.resolve(root);
	fs.mkdirSync(directory, { recursive: true });
	return {
		state: new FileStateStore(path.join(directory, STATE_FILE)),
		secrets: new FileSecretStore(path.join(directory, SECRETS_FILE)),
	};
}

/** A whole store document: the values, and how many writes produced them. */
interface StoreDocument {
	readonly revision: number;
	readonly values: Record<string, unknown>;
}

function emptyDocument(): StoreDocument {
	return { revision: 0, values: {} };
}

function readDocument(file: string): StoreDocument {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return emptyDocument();
		}
		throw new Error(`Could not read the store file ${file}: ${messageOf(error)}.`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not valid JSON (${messageOf(error)}). Repair or remove it: the store never resets a file it cannot read.`, { cause: error });
	}
	return documentOf(parsed, file);
}

function documentOf(parsed: unknown, file: string): StoreDocument {
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw notADocument(file);
	}
	const { revision, values } = parsed as { revision?: unknown; values?: unknown };
	if (typeof revision !== 'number' || !Number.isFinite(revision)) {
		throw notADocument(file);
	}
	if (typeof values !== 'object' || values === null || Array.isArray(values)) {
		throw notADocument(file);
	}
	return { revision, values: values as Record<string, unknown> };
}

function notADocument(file: string): Error {
	return new Error(`${file} is not a store document; it must hold { "revision": number, "values": object }. Repair or remove it: the store never resets a file it cannot read.`);
}

/** A file's identity and last write; a reader that sees a new stamp reloads it. */
function stampOf(file: string): string {
	try {
		const stat = fs.statSync(file, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return 'missing';
		}
		throw error;
	}
}

let tempSeq = 0;

/** Writes the document whole through a temp file in the same folder, so a reader sees the old one or the new one, never half. */
async function writeDocument(file: string, document: StoreDocument, mode?: number): Promise<void> {
	const temp = `${file}.${process.pid}.${++tempSeq}.tmp`;
	try {
		await fs.promises.writeFile(temp, `${JSON.stringify(document, undefined, '\t')}\n`, { encoding: 'utf8', mode });
		if (mode !== undefined) {
			// writeFile's mode only applies to a new file, and the umask may narrow it; the secrets are the owner's alone.
			await fs.promises.chmod(temp, mode);
		}
		await renameWithRetry(temp, file);
	} catch (error) {
		await fs.promises.rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;

/** On Windows a rename over a file another process has open fails until that process lets go, which a scanner or a reader does within moments. */
async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await fs.promises.rename(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
				throw error;
			}
			await new Promise(resolve => setTimeout(resolve, 20 * attempt));
		}
	}
}

/** Who holds a lock, and since when; the token keeps a writer from releasing a lock another writer broke and took. */
interface LockRecord {
	readonly pid: number;
	readonly at: number;
	readonly token: string;
}

let lockSeq = 0;

/**
 * Runs `action` while holding the lock, so no other process reads and writes the
 * same document in between. Exported for the files that keep their own document
 * beside `state.json`, such as the usage days.
 */
export async function withLock<T>(lockFile: string, action: () => Promise<T>): Promise<T> {
	const token = await acquireLock(lockFile);
	try {
		return await action();
	} finally {
		releaseLock(lockFile, token);
	}
}

async function acquireLock(lockFile: string): Promise<string> {
	const token = `${process.pid}-${Date.now()}-${++lockSeq}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		if (claimLock(lockFile, { pid: process.pid, at: Date.now(), token })) {
			return token;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Could not get the lock ${lockFile} within ${LOCK_WAIT_MS} ms; another process holds it.`);
		}
		if (isStaleLock(lockFile)) {
			breakStaleLock(lockFile);
		} else {
			await delay(LOCK_RETRY_MS);
		}
	}
}

function claimLock(lockFile: string, record: LockRecord): boolean {
	let handle: number;
	try {
		handle = fs.openSync(lockFile, 'wx');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return false;
		}
		throw error;
	}
	try {
		fs.writeFileSync(handle, JSON.stringify(record));
	} finally {
		fs.closeSync(handle);
	}
	return true;
}

/** Whether the lock belongs to nobody any more: its owner is gone, or it is older than any write takes. */
function isStaleLock(lockFile: string): boolean {
	let text: string;
	let seenAt: number;
	try {
		const stat = fs.statSync(lockFile);
		seenAt = stat.mtimeMs;
		text = fs.readFileSync(lockFile, 'utf8');
	} catch (error) {
		// Gone between the claim and the look: the caller may claim it at once.
		return (error as NodeJS.ErrnoException).code === 'ENOENT';
	}
	let record: Partial<LockRecord>;
	try {
		record = JSON.parse(text) as Partial<LockRecord>;
	} catch {
		// A record caught half-written says nothing; only its age can.
		return Date.now() - seenAt > LOCK_STALE_MS;
	}
	if (typeof record.pid === 'number' && !isRunning(record.pid)) {
		return true;
	}
	const written = typeof record.at === 'number' ? record.at : seenAt;
	return Date.now() - written > LOCK_STALE_MS;
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// A process another account owns refuses the signal but is there.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Moves a stale lock out of the way; a rename succeeds for one writer only, so two cannot both break the same lock. */
function breakStaleLock(lockFile: string): void {
	const grave = `${lockFile}.${process.pid}.${++lockSeq}.stale`;
	try {
		fs.renameSync(lockFile, grave);
	} catch {
		// Another writer broke it first; the next claim finds that writer's record.
		return;
	}
	fs.rmSync(grave, { force: true });
}

function releaseLock(lockFile: string, token: string): void {
	let record: Partial<LockRecord>;
	try {
		record = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as Partial<LockRecord>;
	} catch {
		return;
	}
	if (record.token === token) {
		fs.rmSync(lockFile, { force: true });
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

/**
 * The engine's state. The newest document on disk is the truth; a store keeps
 * what it last read and reloads when another writer replaced the file, so a
 * `get` costs a stat until something changes.
 */
class FileStateStore implements StateStore {

	/** Values this instance accepted but has not written yet, so a `get` sees its own `update` at once. */
	private readonly unsaved = new Map<string, { readonly value: unknown }>();
	private document = emptyDocument();
	/** An empty stamp forces the next read to go to disk. */
	private stamp = '';
	private pending: Promise<void> = Promise.resolve();
	private readonly lockFile: string;

	constructor(private readonly file: string) {
		this.lockFile = `${file}.lock`;
	}

	get<T>(key: string): T | undefined {
		return this.current().values[key] as T | undefined;
	}

	keys(): readonly string[] {
		return Object.keys(this.current().values);
	}

	update(key: string, value: unknown): Promise<void> {
		const entry = { value };
		this.unsaved.set(key, entry);
		const next = this.pending.then(() => this.write(key, entry));
		this.pending = next.catch(() => undefined);
		return next;
	}

	/** The newest document on disk, with the writes of this instance laid over it. */
	private current(): StoreDocument {
		const stamp = stampOf(this.file);
		if (stamp !== this.stamp) {
			this.document = readDocument(this.file);
			this.stamp = stamp;
		}
		if (this.unsaved.size === 0) {
			return this.document;
		}
		const values = { ...this.document.values };
		for (const [key, entry] of this.unsaved) {
			if (entry.value === undefined) {
				delete values[key];
			} else {
				values[key] = entry.value;
			}
		}
		return { revision: this.document.revision, values };
	}

	/** Merges one key into the newest document, under the lock, so a writer in the other gateway keeps its keys. */
	private async write(key: string, entry: { readonly value: unknown }): Promise<void> {
		try {
			await withLock(this.lockFile, async () => {
				const current = readDocument(this.file);
				const values = { ...current.values };
				if (entry.value === undefined) {
					delete values[key];
				} else {
					values[key] = entry.value;
				}
				await writeDocument(this.file, { revision: current.revision + 1, values });
			});
		} catch (error) {
			if (this.unsaved.get(key) === entry) {
				this.unsaved.delete(key);
				this.stamp = '';
			}
			throw error;
		}
		if (this.unsaved.get(key) === entry) {
			this.unsaved.delete(key);
		}
		// The next read re-reads the file, which also brings in what the other writer added meanwhile.
		this.stamp = '';
	}
}

/** The agents' keys, in a document only the owner's account can read and write. */
class FileSecretStore implements SecretStore {

	private pending: Promise<void> = Promise.resolve();
	private readonly lockFile: string;

	constructor(private readonly file: string) {
		this.lockFile = `${file}.lock`;
	}

	async get(id: string): Promise<string | undefined> {
		await this.pending;
		const value = readDocument(this.file).values[`${SECRET_PREFIX}${id}`];
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}

	set(id: string, value: string): Promise<void> {
		return this.write(values => {
			values[`${SECRET_PREFIX}${id}`] = value;
		});
	}

	delete(id: string): Promise<void> {
		return this.write(values => {
			delete values[`${SECRET_PREFIX}${id}`];
		});
	}

	/** Only the owner may read the file, so the mode is written with the document rather than after it. */
	private write(change: (values: Record<string, unknown>) => void): Promise<void> {
		const next = this.pending.then(() => withLock(this.lockFile, async () => {
			const current = readDocument(this.file);
			const values = { ...current.values };
			change(values);
			await writeDocument(this.file, { revision: current.revision + 1, values }, 0o600);
		}));
		this.pending = next.catch(() => undefined);
		return next;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
