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
import { ServerLink, type LinkState, type ServerLinkDeps } from '../../src/hosts/vscode/serverLink';
import { API_VERSION, SERVER_NAME } from '../../src/hosts/http/wire';
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
		autoStart: true,
		serverScript: STUB,
		extensionDir: path.dirname(STUB),
		log,
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
			child.kill();
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

	it('relays a healthy start at the level the server names, not as a warning', async () => {
		const port = await freePort();
		const lines: Array<{ message: string; level: string | undefined }> = [];
		const log: Log = (message, level) => { lines.push({ message, level }); };
		const link = makeLink({ root: storeRoot(), port, log });

		expect(readyOf(await link.ensure()).owned).toBe(true);

		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && !lines.some(line => line.message.includes('listening'))) {
			await delay(25);
		}
		const start = lines.find(line => line.message.includes('listening'));
		expect(start, 'the server says where it listens').toBeDefined();
		expect(start?.level).toBe('info');
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
