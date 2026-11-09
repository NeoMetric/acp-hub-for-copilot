/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Log, LogLevel } from '../../engine/ports/host';
import { ensureToken, readToken, tokenFileOf } from '../../main/token';
import { STATE_ROUTE } from '../../ui/transport';
import { API_VERSION, SERVER_NAME, type HealthWire } from '../http/wire';

/** What a client needs to reach the server: where it answers, and the token it wants. */
export type ServerEndpoint = { readonly baseUrl: string; readonly token?: string };

/**
 * Whether a window can talk to a server, and whether that server is the one
 * this window started — only a server it started may ever be stopped by it.
 */
export type LinkState =
	| { readonly kind: 'ready'; readonly endpoint: ServerEndpoint; readonly owned: boolean }
	| { readonly kind: 'unavailable'; readonly reason: string };

export interface ServerLinkDeps {
	/** The store root both gateways share; the token file lives here. */
	readonly root: string;
	/** The port the server listens on. */
	readonly port: number;
	/** Whether a window that finds no server may start one. */
	readonly autoStart: boolean;
	/** The built server bundle, `dist/server.js`. */
	readonly serverScript: string;
	/** The folder the server runs in, so the store resolves as it does for the extension. */
	readonly extensionDir: string;
	/** The prompts folder the server composes from, when the extension has one. */
	readonly promptsDir?: string;
	readonly log: Log;
	readonly spawn?: typeof nodeSpawn;
	readonly fetch?: typeof fetch;
	/** How long the link waits between two probes of a server that is still starting. */
	readonly retryMs?: number;
}

/** How long a server this window starts may take to answer. */
const START_TIMEOUT_MS = 15_000;

/** How long one probe may take before it counts as no answer. */
const PROBE_TIMEOUT_MS = 2_000;

/** How long a server this window started gets to leave once its stdin closes. */
const KILL_AFTER_MS = 2_000;

/** How often a reached server is checked again, so a dead one is replaced. */
const WATCH_INTERVAL_MS = 30_000;

/**
 * How long a child that lost the port to another window gets to show it did
 * before its window counts the answering server as its own. A second server
 * cannot bind the port the winner holds, so it exits as soon as it tries.
 */
const SETTLE_MIN_MS = 300;

/** The waiting between two probes of a server that is still starting. */
const DEFAULT_RETRY_MS = 200;

/** The flag that makes the server exit when its stdin closes. */
const EXIT_WITH_PARENT_FLAG = '--exit-with-parent';

/** What one probe of the port found. */
type Probe =
	| { readonly kind: 'absent' }
	| { readonly kind: 'compatible' }
	| { readonly kind: 'incompatible'; readonly reason: string };

/**
 * The window's side of the server's lifecycle: it attaches to a server that
 * answers and is compatible, starts one when none does, and starts another
 * when the one it attached to goes away. It never signals a server it did not
 * start, and the server it starts exits when this window's process does.
 *
 * It holds no VS Code API, so the lifecycle can be tested outside the editor;
 * `onDidChange` is a plain listener set for the same reason.
 */
export class ServerLink {
	private readonly deps: ServerLinkDeps;
	private readonly baseUrl: string;
	private readonly retryMs: number;
	private readonly fetchOf: typeof fetch;
	private readonly spawnOf: typeof nodeSpawn;
	private readonly listeners = new Set<(state: LinkState) => void>();
	private child: ChildProcess | undefined;
	private current: LinkState | undefined;
	private pending: Promise<LinkState> | undefined;
	private watcher: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(deps: ServerLinkDeps) {
		this.deps = deps;
		this.baseUrl = `http://127.0.0.1:${deps.port}`;
		this.retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
		this.fetchOf = deps.fetch ?? fetch;
		this.spawnOf = deps.spawn ?? nodeSpawn;
	}

	/** The last state the link settled on, if it has looked yet. */
	get state(): LinkState | undefined {
		return this.current;
	}

	/** Calls `listener` whenever the state changes, and returns the unsubscribe. */
	onDidChange(listener: (state: LinkState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Attaches to the server, or starts one; concurrent and repeated calls share one answer. */
	async ensure(): Promise<LinkState> {
		if (this.pending) {
			return this.pending;
		}
		const work = this.run();
		this.pending = work;
		try {
			return await work;
		} finally {
			if (this.pending === work) {
				this.pending = undefined;
			}
		}
	}

	/** Stops the server this window started; one it merely attached to keeps running. */
	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.watcher) {
			clearInterval(this.watcher);
			this.watcher = undefined;
		}
		this.listeners.clear();
		const child = this.child;
		this.child = undefined;
		if (!child || gone(child)) {
			return;
		}
		const exited = new Promise<void>(resolve => {
			if (gone(child)) {
				resolve();
				return;
			}
			child.once('exit', () => resolve());
			// A child that never started reports the failure and no exit, so that is the other way out.
			child.once('error', () => resolve());
		});
		try {
			// A closed pipe is how the server learns its window is gone, before any kill.
			child.stdin?.end();
		} catch (error) {
			this.deps.log(`The server's stdin did not close: ${messageOf(error)}`, 'warn');
		}
		const killer = setTimeout(() => {
			if (!gone(child)) {
				child.kill();
			}
		}, KILL_AFTER_MS);
		try {
			// A window that closes must not wait on a process that will never report an exit.
			if (!await settlesWithin(exited, KILL_AFTER_MS + 1000)) {
				this.deps.log(`The server on port ${this.deps.port} did not report that it left; the window stops anyway.`, 'warn');
			}
		} finally {
			clearTimeout(killer);
		}
	}

	private async run(): Promise<LinkState> {
		if (this.disposed) {
			return this.closed();
		}
		try {
			return await this.attachOrStart();
		} catch (error) {
			return this.publish({ kind: 'unavailable', reason: `The server on port ${this.deps.port} could not be reached: ${messageOf(error)}` });
		}
	}

	private async attachOrStart(): Promise<LinkState> {
		const probe = await this.classify();
		// dispose() may have run while the probe was out; a closed link starts nothing.
		if (this.disposed) {
			return this.closed();
		}
		if (probe.kind === 'incompatible') {
			return this.publish({ kind: 'unavailable', reason: probe.reason });
		}
		if (probe.kind === 'compatible') {
			// The server may be one this window started earlier; a watch must not unown it.
			return this.reach(this.ownsRunning());
		}
		if (!this.deps.autoStart) {
			return this.publish({
				kind: 'unavailable',
				reason: `No ACP Hub server answers on port ${this.deps.port}, and this window does not start one.`,
			});
		}
		return this.start();
	}

	/** Verifies the token and reports the server as reachable, watching it from then on. */
	private async reach(owned: boolean): Promise<LinkState> {
		const refused = await this.verifyToken();
		if (this.disposed) {
			return this.closed();
		}
		if (refused) {
			return this.publish({ kind: 'unavailable', reason: refused });
		}
		this.watch();
		return this.publish({
			kind: 'ready',
			endpoint: { baseUrl: this.baseUrl, token: readToken(this.deps.root, process.env) },
			owned,
		});
	}

	private async start(): Promise<LinkState> {
		if (this.disposed) {
			return this.closed();
		}
		if (this.child && !gone(this.child)) {
			// A server this window started is still coming up.
			const ready = await this.waitForCompatible(Date.now() + START_TIMEOUT_MS, () => undefined);
			if (this.disposed) {
				return this.closed();
			}
			return ready ? this.reach(this.ownsRunning()) : this.publish({ kind: 'unavailable', reason: this.didNotAnswer() });
		}
		if (this.disposed) {
			return this.closed();
		}

		ensureToken(this.deps.root);
		this.deps.log(`Starting the ACP Hub server on port ${this.deps.port}.`);
		const child = this.spawnServer();
		this.child = child;
		let stderr = '';
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (text: string) => {
			stderr += text;
			for (const line of text.split(/\r?\n/)) {
				const said = line.trim();
				if (said) {
					this.deps.log(said, levelOf(said));
				}
			}
		});
		// A dispose() that slipped in before the spawn owns no child, so the link must end this one.
		if (this.disposed) {
			stopChild(child);
			return this.closed();
		}
		let spawnError: string | undefined;
		child.on('error', error => {
			spawnError = error.message;
			// A child that never started is no server: nothing may count it as one this window owns.
			if (this.child === child) {
				this.child = undefined;
			}
		});
		child.on('exit', (code, signal) => {
			this.deps.log(`The server on port ${this.deps.port} exited (${signal ?? `code ${code}`}).`, 'warn');
		});
		const giveUp = (): string | undefined => {
			if (spawnError) {
				return `The ACP Hub server could not be started: ${spawnError}`;
			}
			// Losing the port race to a window that started its server first is not a failure.
			if (child.exitCode !== null && !stderr.includes('EADDRINUSE')) {
				const said = lastLine(stderr);
				return `The ACP Hub server on port ${this.deps.port} exited with code ${child.exitCode}${said ? `: ${said}` : '.'}`;
			}
			return undefined;
		};

		if (await this.waitForCompatible(Date.now() + START_TIMEOUT_MS, giveUp)) {
			return this.reach(await this.survived(child, () => stderr));
		}
		if (this.disposed) {
			return this.closed();
		}

		// Another window may have won the port while this child was starting.
		const probe = await this.classify();
		if (probe.kind === 'compatible') {
			return this.reach(false);
		}
		if (probe.kind === 'incompatible') {
			return this.publish({ kind: 'unavailable', reason: probe.reason });
		}
		const stopped = giveUp();
		if (stopped) {
			return this.publish({ kind: 'unavailable', reason: stopped });
		}
		const reason = stderr.includes('EADDRINUSE')
			? `Port ${this.deps.port} is held by another process; stop it or change the port this window uses.`
			: this.didNotAnswer();
		return this.publish({ kind: 'unavailable', reason });
	}

	private spawnServer(): ChildProcess {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			// The extension host is Electron, which runs a script as node only when told to.
			ELECTRON_RUN_AS_NODE: '1',
			ACP_HUB_PORT: String(this.deps.port),
		};
		if (this.deps.promptsDir) {
			env.ACP_HUB_PROMPTS_DIR = this.deps.promptsDir;
		}
		return this.spawnOf(process.execPath, [this.deps.serverScript, EXIT_WITH_PARENT_FLAG], {
			cwd: this.deps.extensionDir,
			env,
			stdio: ['pipe', 'ignore', 'pipe'],
			windowsHide: true,
		});
	}

	private async waitForCompatible(deadline: number, giveUp: () => string | undefined): Promise<boolean> {
		while (Date.now() < deadline) {
			if (this.disposed) {
				return false;
			}
			const probe = await this.classify();
			if (probe.kind === 'compatible') {
				return true;
			}
			if (probe.kind === 'incompatible' || giveUp()) {
				return false;
			}
			await delay(this.retryMs);
		}
		return false;
	}

	/**
	 * Whether the server that answered is the one this window started: a child
	 * that lost the port race leaves within a moment, and one that is still
	 * there afterwards is the process the port now belongs to.
	 */
	private async survived(child: ChildProcess, stderr: () => string): Promise<boolean> {
		const deadline = Date.now() + Math.max(this.retryMs * 3, SETTLE_MIN_MS);
		while (Date.now() < deadline) {
			if (gone(child) || stderr().includes('EADDRINUSE')) {
				return false;
			}
			await delay(Math.min(this.retryMs, 50));
		}
		return !gone(child);
	}

	private async classify(): Promise<Probe> {
		let response: Response;
		try {
			response = await this.fetchOf(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		} catch {
			return { kind: 'absent' };
		}
		let health: Partial<HealthWire> = {};
		try {
			health = await response.json() as Partial<HealthWire>;
		} catch {
			// A body that is not JSON says nothing about who answers.
		}
		if (!response.ok) {
			return { kind: 'incompatible', reason: `The server on port ${this.deps.port} answered the health check with HTTP ${response.status}; stop that process or change the port this window uses.` };
		}
		if (health.name !== SERVER_NAME) {
			const called = typeof health.name === 'string' ? ` (it calls itself "${health.name}")` : '';
			return { kind: 'incompatible', reason: `The server on port ${this.deps.port} is not ACP Hub${called}; stop that process or change the port this window uses.` };
		}
		if (health.apiVersion !== API_VERSION) {
			return { kind: 'incompatible', reason: `The server on port ${this.deps.port} answers /health with apiVersion ${health.apiVersion ?? 'none'} and this window speaks ${API_VERSION}; update that server.` };
		}
		return { kind: 'compatible' };
	}

	/**
	 * Why the server cannot be used, or `undefined` when the token it wants is the one this window holds.
	 *
	 * The cheap state route is asked, not the model list: a cold server fills that list by waking
	 * every agent, which can take longer than a probe is allowed. A probe that runs out of its own
	 * time is no answer about the token either, so an answering `/health` is not undone by it.
	 */
	private async verifyToken(): Promise<string | undefined> {
		const token = readToken(this.deps.root, process.env);
		let response: Response;
		try {
			response = await this.fetchOf(`${this.baseUrl}${STATE_ROUTE}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
		} catch (error) {
			if (timedOut(error)) {
				this.deps.log(`The server on port ${this.deps.port} did not answer the token check within ${PROBE_TIMEOUT_MS} ms; its token is left unchecked.`, 'debug');
				return undefined;
			}
			return `The ACP Hub server on port ${this.deps.port} stopped answering: ${messageOf(error)}`;
		}
		try {
			await response.arrayBuffer();
		} catch {
			// The status already said what matters; a body that did not arrive says nothing more.
		}
		if (response.status === 401) {
			return `The ACP Hub server on port ${this.deps.port} rejected the token; check ${tokenFileOf(this.deps.root)}.`;
		}
		if (!response.ok) {
			return `The ACP Hub server on port ${this.deps.port} answered the state check with HTTP ${response.status}.`;
		}
		return undefined;
	}

	private didNotAnswer(): string {
		return `The ACP Hub server on port ${this.deps.port} did not answer within ${START_TIMEOUT_MS / 1000} s.`;
	}

	private closed(): LinkState {
		return this.publish({ kind: 'unavailable', reason: `The link to the server on port ${this.deps.port} is closed.` });
	}

	/** Whether the server that answers is one this window started and that still runs. */
	private ownsRunning(): boolean {
		return this.child !== undefined && !gone(this.child);
	}

	private watch(): void {
		if (this.watcher || this.disposed) {
			return;
		}
		// A light check, so a server that dies between turns is replaced on the next one.
		this.watcher = setInterval(() => {
			void this.ensure();
		}, WATCH_INTERVAL_MS);
		this.watcher.unref();
	}

	private publish(state: LinkState): LinkState {
		if (!sameState(this.current, state)) {
			this.current = state;
			for (const listener of this.listeners) {
				try {
					listener(state);
				} catch (error) {
					this.deps.log(`A listener of the server link failed: ${messageOf(error)}`, 'warn');
				}
			}
		}
		return state;
	}
}

function sameState(current: LinkState | undefined, next: LinkState): boolean {
	if (!current || current.kind !== next.kind) {
		return false;
	}
	if (current.kind === 'ready' && next.kind === 'ready') {
		return current.owned === next.owned && current.endpoint.baseUrl === next.endpoint.baseUrl && current.endpoint.token === next.endpoint.token;
	}
	if (current.kind === 'unavailable' && next.kind === 'unavailable') {
		return current.reason === next.reason;
	}
	return true;
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Whether `work` finished before `ms` went by; the timer is cleared either way. */
async function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const bound = new Promise<false>(resolve => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([work.then(() => true as const), bound]);
	} finally {
		clearTimeout(timer);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether a fetch gave up on its own timer, rather than on a server that went away. */
function timedOut(error: unknown): boolean {
	return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Whether the child has left, however it did; one that never started has no pid and never exits. */
function gone(child: ChildProcess): boolean {
	return child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
}

/** Ends a server this window started when the window is already closing: no waiting, just the pipe and the kill. */
function stopChild(child: ChildProcess): void {
	try {
		child.stdin?.end();
	} catch {
		// The pipe is gone already; the kill below is what leaves no process behind.
	}
	if (!gone(child)) {
		child.kill();
	}
}

function lastLine(text: string): string | undefined {
	return text.split(/\r?\n/).map(line => line.trim()).filter(line => line).pop();
}

/** The level a line of the server's own log names, which it writes before the message. */
function levelOf(line: string): LogLevel {
	const words = line.split(/\s+/);
	const at = /^\d{4}-\d{2}-\d{2}T/.test(words[0]) ? 1 : 0;
	switch ((words[at] ?? '').toUpperCase()) {
		case 'DEBUG':
			return 'debug';
		case 'WARN':
		case 'WARNING':
			return 'warn';
		case 'ERROR':
			return 'error';
		default:
			// INFO and a line the server did not format are both news, not warnings.
			return 'info';
	}
}
