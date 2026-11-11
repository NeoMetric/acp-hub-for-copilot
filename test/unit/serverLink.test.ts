/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Log } from '../../src/engine/ports/host';
import { ServerLink, stopMarkerOf, type LinkState, type ServerLinkDeps } from '../../src/hosts/vscode/serverLink';
import { API_VERSION, SERVER_NAME, SHUTDOWN_ROUTE } from '../../src/hosts/http/wire';
import { tokenFileOf } from '../../src/main/token';

const STUB = path.resolve(__dirname, '..', 'fixtures', 'stub-server.cjs');
const log: Log = () => undefined;

const children: ChildProcess[] = [];
const links: ServerLink[] = [];
const servers: http.Server[] = [];
const roots: string[] = [];

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** A port nothing listens on, taken and given back so the OS can hand it to a server. */
async function freePort(): Promise<number> {
	const probe = net.createServer();
	await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>(resolve => probe.close(() => resolve()));
	return port;
}

function storeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-link-'));
	roots.push(root);
	return root;
}

/** Whether the port answers anything at all; a refused connection means nothing is there. */
async function answers(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`);
		await response.arrayBuffer();
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(ready: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await ready()) {
			return;
		}
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${what}.`);
}

function waitForHealth(port: number): Promise<void> {
	return waitUntil(() => answers(port), `a server on port ${port}`);
}

function waitForPortClosed(port: number): Promise<void> {
	return waitUntil(async () => !(await answers(port)), `port ${port} to close`);
}

/** Resolves `work` or 'timeout', whichever comes first; the timer never outlives the test. */
async function within(work: Promise<void>, ms: number): Promise<'done' | 'timeout'> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<'timeout'>(resolve => {
		timer = setTimeout(() => resolve('timeout'), ms);
	});
	try {
		return await Promise.race([work.then(() => 'done' as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** A stub server started by the test itself, on the port the test picked. */
function startStub(options: { port: number; token?: string; args?: readonly string[]; env?: Record<string, string> }): ChildProcess {
	const child = nodeSpawn(process.execPath, [STUB, ...(options.args ?? [])], {
		env: { ...process.env, ACP_HUB_PORT: String(options.port), ...(options.token ? { ACP_HUB_TOKEN: options.token } : {}), ...options.env },
		stdio: ['pipe', 'ignore', 'pipe'],
		windowsHide: true,
	});
	children.push(child);
	child.stderr?.resume();
	return child;
}

/**
 * The spawn the link is given when the server cannot start at all: no pid, the
 * failure reported once, and no exit after it, the way `spawn` fails with ENOENT.
 */
function neverStarting(): ServerLinkDeps['spawn'] {
	const spawn = (() => {
		const child = new EventEmitter() as unknown as ChildProcess;
		Object.assign(child, {
			pid: undefined,
			exitCode: null,
			signalCode: null,
			stdin: null,
			stdout: null,
			stderr: null,
			kill: () => false,
		});
		setTimeout(() => child.emit('error', Object.assign(new Error('spawn acp-hub-server ENOENT'), { code: 'ENOENT' })), 0);
		return child;
	}) as unknown as ServerLinkDeps['spawn'];
	return spawn;
}

/** A server of the test's own, answering every route with the body it is given. */
async function startAnswering(port: number, body: unknown): Promise<http.Server> {
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(body));
	});
	servers.push(server);
	await new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve()));
	return server;
}

/** The spawn the link is given: the real one, with the child kept so the test can stop it. */
function capturing(spawned: ChildProcess[]): ServerLinkDeps['spawn'] {
	const wrapper = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
		const child = nodeSpawn(command, args, options);
		spawned.push(child);
		children.push(child);
		return child;
	};
	return wrapper as unknown as ServerLinkDeps['spawn'];
}

function makeLink(deps: { root: string; port: number } & Partial<ServerLinkDeps>): ServerLink {
	const link = new ServerLink({
		serverScript: STUB,
		extensionDir: path.dirname(STUB),
		log,
		serverLog: log,
		retryMs: 50,
		spawn: capturing([]),
		...deps,
	});
	links.push(link);
	return link;
}

function readyOf(state: LinkState): Extract<LinkState, { kind: 'ready' }> {
	expect(state.kind, JSON.stringify(state)).toBe('ready');
	return state as Extract<LinkState, { kind: 'ready' }>;
}

function reasonOf(state: LinkState): string {
	expect(state.kind, JSON.stringify(state)).toBe('unavailable');
	return (state as Extract<LinkState, { kind: 'unavailable' }>).reason;
}

afterEach(async () => {
	for (const link of links.splice(0)) {
		await link.dispose();
	}
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
			child.kill();
			// A process keeps the folder it runs in from being deleted until it is gone.
			await within(exited, 3_000);
		}
	}
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

describe('the link to the server', () => {
	it('attaches to a compatible server without spawning', async () => {
		const port = await freePort();
		startStub({ port });
		await waitForHealth(port);
		const spawn = vi.fn();
		const link = makeLink({ root: storeRoot(), port, spawn: spawn as unknown as ServerLinkDeps['spawn'] });

		const state = await link.ensure();

		const ready = readyOf(state);
		expect(ready.owned).toBe(false);
		expect(ready.endpoint.baseUrl).toBe(`http://127.0.0.1:${port}`);
		expect(spawn, 'a server that answers is never started again').not.toHaveBeenCalled();
		expect(link.state).toEqual(state);
	});

	it('spawns when nothing answers and reports owned: true', async () => {
		const port = await freePort();
		const root = storeRoot();
		const link = makeLink({ root, port });

		const state = await link.ensure();

		expect(readyOf(state).owned).toBe(true);
		await waitForHealth(port);
		expect(fs.existsSync(tokenFileOf(root)), 'the server it starts shares the stored token').toBe(true);
	});

	it('starts the server from the store, not from the extension folder, so an update can replace that folder', async () => {
		const port = await freePort();
		const root = storeRoot();
		const extensionDir = path.dirname(STUB);
		let seen: { command: string; args: readonly string[]; options: SpawnOptions } | undefined;
		const spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
			seen = { command, args, options };
			const child = new EventEmitter() as unknown as ChildProcess;
			Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, stdin: null, stdout: null, stderr: null, kill: () => false });
			setTimeout(() => child.emit('error', Object.assign(new Error('spawn acp-hub-server ENOENT'), { code: 'ENOENT' })), 0);
			return child;
		}) as unknown as ServerLinkDeps['spawn'];
		const link = makeLink({ root, port, extensionDir, spawn });

		reasonOf(await link.ensure());

		expect(seen?.options.cwd, 'a process whose working directory is the extension folder blocks its own update').toBe(root);
		expect((seen?.options.env as NodeJS.ProcessEnv).ACP_HUB_EXTENSION_DIR).toBe(extensionDir);
		expect(seen?.args).toContain('--exit-with-parent');
	});

	it('two links race on one port: both end ready, exactly one owns', async () => {
		const port = await freePort();
		const root = storeRoot();
		const first = makeLink({ root, port });
		const second = makeLink({ root, port });

		const states = await Promise.all([first.ensure(), second.ensure()]);

		const owners = states.filter(state => readyOf(state).owned);
		expect(owners).toHaveLength(1);
	});

	it('keeps ownership when a later ensure finds the server it started', async () => {
		const port = await freePort();
		const link = makeLink({ root: storeRoot(), port });
		const changes: LinkState[] = [];
		link.onDidChange(state => changes.push(state));

		expect(readyOf(await link.ensure()).owned).toBe(true);
		const again = readyOf(await link.ensure());

		expect(again.owned, 'the server it started is still its own').toBe(true);
		expect(changes, 'an unchanged state is not reported a second time').toHaveLength(1);
	});

	it('a dispose during the first probe leaves no server behind', async () => {
		const port = await freePort();
		const spawned: ChildProcess[] = [];
		const link = makeLink({ root: storeRoot(), port, spawn: capturing(spawned) });

		const pending = link.ensure();
		const stopped = link.dispose();
		const [state] = await Promise.all([pending, stopped]);

		expect(reasonOf(state)).toContain('closed');
		await waitUntil(
			async () => spawned.every(child => child.exitCode !== null || child.signalCode !== null),
			'the server a racing start spawned to exit',
		);
		expect(await answers(port), 'nothing is left listening on the port').toBe(false);
	});

	it('a non-ACP server on the port is unavailable and never signalled', async () => {
		const port = await freePort();
		const server = await startAnswering(port, { status: 'ok', app: 'something else' });
		const link = makeLink({ root: storeRoot(), port });

		const state = await link.ensure();

		expect(reasonOf(state)).toContain('not ACP Hub');
		await link.dispose();
		expect(server.listening, 'the other process is left alone').toBe(true);
		expect(await answers(port)).toBe(true);
	});

	it('an old server without apiVersion is unavailable with a readable reason', async () => {
		const port = await freePort();
		await startAnswering(port, { status: 'ok', name: 'acp-hub', version: '0.0.0', openSessions: 0, agents: [] });
		const link = makeLink({ root: storeRoot(), port });

		expect(reasonOf(await link.ensure())).toContain('apiVersion');
	});

	it('a 401 names the token file', async () => {
		const port = await freePort();
		const root = storeRoot();
		startStub({ port, token: 'a-token-this-window-does-not-have' });
		await waitForHealth(port);
		const link = makeLink({ root, port });

		expect(reasonOf(await link.ensure())).toContain(tokenFileOf(root));
	});

	it('a healthy server whose model list is slow is not called unavailable', async () => {
		const port = await freePort();
		startStub({ port, env: { ACP_HUB_SLOW_MODELS_MS: '4000' } });
		await waitForHealth(port);
		const link = makeLink({ root: storeRoot(), port });
		const started = Date.now();

		const state = await link.ensure();

		expect(readyOf(state).owned).toBe(false);
		expect(Date.now() - started, 'the token check does not wait on the cold model list').toBeLessThan(2_000);
	});

	it('a token check that runs out of time is no answer about the token', async () => {
		const port = await freePort();
		const server = http.createServer((request, response) => {
			if (request.url === '/health') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ status: 'ok', name: SERVER_NAME, version: '0.0.0', apiVersion: API_VERSION, openSessions: 0, agents: [] }));
				return;
			}
			// The state route never answers, the way a server that is still warming up holds the request.
		});
		servers.push(server);
		await new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve()));
		const link = makeLink({ root: storeRoot(), port });

		const state = await link.ensure();

		expect(readyOf(state).owned, 'a /health that answers is not undone by a slow token check').toBe(false);
	});

	it('a server that never starts owns nothing, and dispose does not wait for it', async () => {
		const port = await freePort();
		const link = makeLink({ root: storeRoot(), port, spawn: neverStarting() });

		expect(reasonOf(await link.ensure())).toContain('could not be started');

		// Another window started its server on the same port while this one was failing.
		startStub({ port });
		await waitForHealth(port);

		expect(readyOf(await link.ensure()).owned, 'a child that never started is not a server this window owns').toBe(false);
		expect(await within(link.dispose(), 2_000), 'dispose never waits for an exit that cannot come').toBe('done');
	});

	it('relays a healthy start to the server log at the level the server names, not as a warning', async () => {
		const port = await freePort();
		const lines: Array<{ message: string; level: string | undefined }> = [];
		const window: string[] = [];
		const serverLog: Log = (message, level) => { lines.push({ message, level }); };
		const link = makeLink({ root: storeRoot(), port, serverLog, log: message => { window.push(message); } });

		expect(readyOf(await link.ensure()).owned).toBe(true);

		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && !lines.some(line => line.message.includes('listening'))) {
			await delay(25);
		}
		const start = lines.find(line => line.message.includes('listening'));
		expect(start, 'the server says where it listens').toBeDefined();
		expect(start?.level).toBe('info');
		expect(window.some(line => line.includes('listening')), 'what the server says is not the window\'s line').toBe(false);
		expect(window.some(line => line.includes('Starting the ACP Hub server')), 'what the window does is its own line').toBe(true);
	});

	it('takes over when the owner\'s server dies', async () => {
		const port = await freePort();
		const root = storeRoot();
		const spawned: ChildProcess[] = [];
		const windowA = makeLink({ root, port, spawn: capturing(spawned) });
		expect(readyOf(await windowA.ensure()).owned).toBe(true);
		const windowB = makeLink({ root, port });
		expect(readyOf(await windowB.ensure()).owned).toBe(false);

		// Window A goes away without stopping its server.
		spawned[0].kill();
		await waitForPortClosed(port);

		expect(readyOf(await windowB.ensure()).owned, 'the window now starts its own server').toBe(true);
		await waitForHealth(port);
	});

	it('dispose stops an owned server and leaves an attached one running', async () => {
		const ownedPort = await freePort();
		const owner = makeLink({ root: storeRoot(), port: ownedPort });
		expect(readyOf(await owner.ensure()).owned).toBe(true);

		await owner.dispose();

		await waitForPortClosed(ownedPort);

		const attachedPort = await freePort();
		startStub({ port: attachedPort });
		await waitForHealth(attachedPort);
		const stranger = makeLink({ root: storeRoot(), port: attachedPort });
		expect(readyOf(await stranger.ensure()).owned).toBe(false);

		await stranger.dispose();

		expect(await answers(attachedPort), 'a server this window did not start keeps running').toBe(true);
	});

	it('the server the window starts exits when the window\'s stdin closes', async () => {
		const port = await freePort();
		const child = startStub({ port, args: ['--exit-with-parent'] });
		await waitForHealth(port);
		const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));

		child.stdin?.destroy();

		expect(await within(exited, 3_000), 'the server exits when its parent goes').toBe('done');
	});
});

describe('a server that runs on its own', () => {
	it('is started apart from the window, with its idle limit, and is left running when the window closes', async () => {
		const port = await freePort();
		const root = storeRoot();
		const spawned: ChildProcess[] = [];
		let seen: SpawnOptions | undefined;
		let seenArgs: readonly string[] = [];
		const real = capturing(spawned) as unknown as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
		const spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
			seen = options;
			seenArgs = args;
			return real(command, args, options);
		}) as unknown as ServerLinkDeps['spawn'];
		const link = makeLink({ root, port, detached: true, idleMinutes: 7, spawn });

		const ready = readyOf(await link.ensure());
		await link.dispose();

		expect(ready.owned).toBe(true);
		expect(seen?.detached).toBe(true);
		expect(seen?.stdio, 'no pipe to the window that a closing window would break').toEqual(['ignore', expect.any(Number), expect.any(Number)]);
		expect(seenArgs).toContain('--detached');
		expect(seenArgs).not.toContain('--exit-with-parent');
		expect(seen?.env?.ACP_HUB_IDLE_MINUTES).toBe('7');
		await delay(300);
		expect(await answers(port), 'closing the window leaves the server it started').toBe(true);
		expect(fs.readFileSync(path.join(root, 'server.log'), 'utf8')).toContain('stub-server listening');
	});

	it('runs on the Node it is given, not on the editor\'s binary', async () => {
		const port = await freePort();
		let command: string | undefined;
		const real = capturing([]) as unknown as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
		const spawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
			command = file;
			// The test's own Node stands in for the one found; the file name is what is checked.
			return real(process.execPath, args, options);
		}) as unknown as ServerLinkDeps['spawn'];
		const link = makeLink({ root: storeRoot(), port, detached: true, spawn, nodeCommand: async () => 'C:\\tools\\node.exe' });

		readyOf(await link.ensure());

		expect(command).toBe('C:\\tools\\node.exe');
	});

	it('falls back to the editor\'s binary when no Node is found', async () => {
		const port = await freePort();
		let command: string | undefined;
		const real = capturing([]) as unknown as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
		const spawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
			command = file;
			return real(file, args, options);
		}) as unknown as ServerLinkDeps['spawn'];
		const link = makeLink({ root: storeRoot(), port, detached: true, spawn, nodeCommand: async () => undefined });

		readyOf(await link.ensure());

		expect(command).toBe(process.execPath);
	});

	it('shows a running server\'s later log lines in the server log, also in a window that did not start it', async () => {
		const port = await freePort();
		const root = storeRoot();
		readyOf(await makeLink({ root, port, detached: true }).ensure());
		const lines: string[] = [];
		const watcher = makeLink({ root, port, detached: true, serverLog: (message: string) => { lines.push(message); } });

		expect(readyOf(await watcher.ensure()).owned).toBe(false);
		fs.appendFileSync(path.join(root, 'server.log'), `${new Date().toISOString()} INFO [claude] a chat started\n`);

		await waitUntil(async () => lines.some(line => line.includes('a chat started')), 'the log line in the server log', 3_000);
	});

	it('shows the end of a log written before it attached, whole lines only, and each line once', async () => {
		const port = await freePort();
		const root = storeRoot();
		const file = path.join(root, 'server.log');
		// A log larger than the stretch a window shows, so the first line it reads starts mid-line.
		const filler: string[] = [];
		for (let index = 0; index < 5_000; index++) {
			filler.push(`${new Date().toISOString()} INFO [filler] line ${index} ${'x'.repeat(40)}\n`);
		}
		filler.push(`${new Date().toISOString()} INFO [claude] a line written before the window attached\n`);
		fs.writeFileSync(file, filler.join(''));

		readyOf(await makeLink({ root, port, detached: true }).ensure());
		const lines: string[] = [];
		const watcher = makeLink({ root, port, detached: true, serverLog: (message: string) => { lines.push(message); } });

		expect(readyOf(await watcher.ensure()).owned).toBe(false);

		await waitUntil(async () => lines.some(line => line.includes('a line written before')), 'the lines of the log it attached to', 3_000);
		expect(lines.filter(line => line.includes('a line written before')), 'the line it missed before is shown once').toHaveLength(1);
		expect(lines[0], 'the first line it reads is whole').toMatch(/^\[filler\] line \d+ x+$/);
		// The start of the server it attached to is in the stretch it shows too.
		await waitUntil(async () => lines.some(line => line.includes('listening')), 'the start of the server in the replayed log', 3_000);
	});

	it('stops the server on request and leaves it stopped until it is asked for again', async () => {
		const port = await freePort();
		const root = storeRoot();
		const link = makeLink({ root, port, detached: true });
		readyOf(await link.ensure());

		expect(await link.stopServer()).toBe(true);

		await waitForPortClosed(port);
		expect(reasonOf(link.state!)).toContain('was stopped');
		readyOf(await link.ensure());
		await waitForHealth(port);
	});

	it('leaves a stopped server stopped for background callers, and starts it for a chat', async () => {
		const port = await freePort();
		const link = makeLink({ root: storeRoot(), port, detached: true });
		readyOf(await link.ensure());
		expect(await link.stopServer()).toBe(true);
		await waitForPortClosed(port);

		const background = await link.ensure({ background: true });

		expect(reasonOf(background)).toContain('was stopped');
		await delay(500);
		expect(await answers(port), 'the sidebar reconnecting must not start it again').toBe(false);
		readyOf(await link.ensure());
		await waitForHealth(port);
	});

	it('starts no server for a background caller when autoStart is off, and starts one when a chat asks', async () => {
		const port = await freePort();
		const spawned: ChildProcess[] = [];
		const link = makeLink({ root: storeRoot(), port, detached: true, autoStart: false, spawn: capturing(spawned) });

		const background = await link.ensure({ background: true });

		expect(reasonOf(background)).toContain('acpHub.server.autoStart is off');
		expect(spawned, 'a window starts no server it was told not to start').toHaveLength(0);
		expect(await answers(port)).toBe(false);

		readyOf(await link.ensure());
		await waitForHealth(port);
	});

	it('records the stop before it asks the server to close, so another window sees it during the shutdown', async () => {
		const port = await freePort();
		const root = storeRoot();
		readyOf(await makeLink({ root, port, detached: true }).ensure());
		let recordedWhenAsked: boolean | undefined;
		const asking = vi.fn();
		const fetchOf = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).endsWith(SHUTDOWN_ROUTE)) {
				asking();
				recordedWhenAsked = fs.existsSync(stopMarkerOf(root));
			}
			return fetch(url, init);
		}) as typeof fetch;
		const link = makeLink({ root, port, detached: true, fetch: fetchOf });

		expect(await link.stopServer()).toBe(true);

		expect(asking).toHaveBeenCalled();
		expect(recordedWhenAsked, 'the record is there before the server is asked to close').toBe(true);
		expect(fs.existsSync(stopMarkerOf(root)), 'a stop that stuck stays recorded').toBe(true);
	});

	it('takes the record back when the server would not stop', async () => {
		const port = await freePort();
		const root = storeRoot();
		const link = makeLink({ root, port, detached: true });

		expect(await link.stopServer(), 'nothing answers, so nothing was stopped').toBe(false);

		expect(fs.existsSync(stopMarkerOf(root)), 'a stop that failed leaves no record').toBe(false);
	});

	it('another window starts no server after the stop, while a chat does', async () => {
		const port = await freePort();
		const root = storeRoot();
		const first = makeLink({ root, port, detached: true });
		readyOf(await first.ensure());
		expect(await first.stopServer()).toBe(true);
		await waitForPortClosed(port);
		const spawned: ChildProcess[] = [];
		// The second link has no memory of the stop: only the store root tells it.
		const second = makeLink({ root, port, detached: true, spawn: capturing(spawned) });

		const background = await second.ensure({ background: true });

		expect(reasonOf(background)).toContain('was stopped');
		expect(spawned, 'a window that opens after the stop starts nothing').toHaveLength(0);
		await delay(300);
		expect(await answers(port)).toBe(false);
		expect(fs.existsSync(stopMarkerOf(root)), 'the stop is still recorded').toBe(true);

		const asked = readyOf(await second.ensure());

		expect(asked.owned).toBe(true);
		expect(fs.existsSync(stopMarkerOf(root)), 'a chat asked for the server, so the stop is over').toBe(false);
		await waitForHealth(port);
	});

	it('a background caller uses a server that answers after a stop, and the stop is over then', async () => {
		const port = await freePort();
		const root = storeRoot();
		// The user stopped the server, and one was started deliberately afterwards.
		fs.writeFileSync(stopMarkerOf(root), 'stopped\n');
		startStub({ port });
		await waitForHealth(port);
		const spawn = vi.fn();
		const link = makeLink({ root, port, spawn: spawn as unknown as ServerLinkDeps['spawn'] });

		const state = readyOf(await link.ensure({ background: true }));

		expect(state.owned).toBe(false);
		expect(spawn, 'a server that answers is attached to, not started').not.toHaveBeenCalled();
		expect(fs.existsSync(stopMarkerOf(root)), 'a server that answers means nothing is stopped').toBe(false);
	});

	it('the watch of another window starts no server after the stop', async () => {
		const port = await freePort();
		const root = storeRoot();
		const owner = makeLink({ root, port, detached: true });
		readyOf(await owner.ensure());
		const spawned: ChildProcess[] = [];
		const other = makeLink({ root, port, detached: true, watchMs: 100, spawn: capturing(spawned) });
		expect(readyOf(await other.ensure()).owned, 'the other window only attached').toBe(false);

		expect(await owner.stopServer()).toBe(true);
		await waitForPortClosed(port);

		// Several checks of the other window's watch, which used to start a new server a few seconds later.
		await delay(600);

		expect(spawned, 'the watch of a window that did not stop it starts nothing').toHaveLength(0);
		expect(await answers(port)).toBe(false);
		expect(reasonOf(other.state!), 'the other window says why the server is away').toContain('was stopped');
	});

	it('replaces a server of an older version, so an update takes effect', async () => {
		const port = await freePort();
		const root = storeRoot();
		vi.stubEnv('ACP_HUB_VERSION', '0.0.2');
		try {
			startStub({ port, env: { ACP_HUB_VERSION: '0.0.1' } });
			await waitForHealth(port);
			const link = makeLink({ root, port, detached: true, version: '0.0.2' });

			readyOf(await link.ensure());

			const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { version: string };
			expect(health.version).toBe('0.0.2');
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('keeps a server of a newer version, which another window may have started', async () => {
		const port = await freePort();
		startStub({ port, env: { ACP_HUB_VERSION: '0.0.3' } });
		await waitForHealth(port);
		const spawn = vi.fn();
		const link = makeLink({ root: storeRoot(), port, detached: true, version: '0.0.2', spawn: spawn as unknown as ServerLinkDeps['spawn'] });

		const ready = readyOf(await link.ensure());

		expect(ready.owned).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe('the port the link looks for the server on', () => {
	function savePort(root: string, port: number): void {
		fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ acpHub: { server: { port } } }));
	}

	function probing(urls: string[]): typeof fetch {
		return (async (input: string | URL | Request) => {
			urls.push(String(input));
			throw new Error('refused');
		}) as unknown as typeof fetch;
	}

	it('is the port saved in config.json, read again each time, and the server is left to read it itself', async () => {
		vi.stubEnv('ACP_HUB_PORT', '1234');
		try {
			const root = storeRoot();
			savePort(root, 9100);
			const urls: string[] = [];
			const spawned: SpawnOptions[] = [];
			const refusing = neverStarting() as unknown as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
			const spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
				spawned.push(options);
				return refusing(command, args, options);
			}) as unknown as ServerLinkDeps['spawn'];
			const link = new ServerLink({
				root, serverScript: STUB, extensionDir: path.dirname(STUB), log, serverLog: log, retryMs: 10, spawn, fetch: probing(urls),
			});
			links.push(link);

			await link.ensure();

			expect(urls[0]).toBe('http://127.0.0.1:9100/health');
			expect(spawned[0]?.env?.ACP_HUB_PORT, 'the server reads config.json, so no port is forced on it').toBeUndefined();

			savePort(root, 9200);
			urls.length = 0;
			await link.ensure();

			expect(urls[0]).toBe('http://127.0.0.1:9200/health');
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('is 8791 when nothing is saved', async () => {
		const urls: string[] = [];
		const link = new ServerLink({
			root: storeRoot(), serverScript: STUB, extensionDir: path.dirname(STUB), log, serverLog: log, retryMs: 10, spawn: neverStarting(), fetch: probing(urls),
		});
		links.push(link);

		await link.ensure();

		expect(urls[0]).toBe('http://127.0.0.1:8791/health');
	});

	it('is the port a test names, which the server is then told', async () => {
		const spawned: SpawnOptions[] = [];
		const refusing = neverStarting() as unknown as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
		const spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
			spawned.push(options);
			return refusing(command, args, options);
		}) as unknown as ServerLinkDeps['spawn'];
		const root = storeRoot();
		savePort(root, 9100);
		const link = new ServerLink({
			root, port: 9300, serverScript: STUB, extensionDir: path.dirname(STUB), log, serverLog: log, retryMs: 10, spawn, fetch: probing([]),
		});
		links.push(link);

		await link.ensure();

		expect(spawned[0]?.env?.ACP_HUB_PORT).toBe('9300');
	});
});
