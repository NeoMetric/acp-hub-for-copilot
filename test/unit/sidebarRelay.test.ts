/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkState, ServerLink } from '../../src/hosts/vscode/serverLink';
import { SidebarRelay, type SidebarRelayDeps } from '../../src/sidebar/relay';
import type { AgentCardState, ControlAction, ControlState } from '../../src/ui/messages';
import { ACTION_ROUTE, EVENTS_ROUTE, STATE_ROUTE } from '../../src/ui/transport';

const TOKEN = 'test-token';

/** A snapshot shaped as the server builds one, so the relay has nothing to add to it. */
function stateOf(card: Partial<AgentCardState> = {}): ControlState {
	return {
		agents: [{
			id: 'a',
			displayName: 'Agent A',
			install: 'installed',
			removable: true,
			signedIn: 'yes',
			hasSavedKey: false,
			enabled: true,
			visible: true,
			settings: [],
			usage: { status: 'idle', windows: [] },
			...card,
		}],
		globalSettings: [],
	};
}

interface StubRequest {
	method: string;
	path: string;
	authorization?: string;
	body?: string;
}

interface Stub {
	readonly baseUrl: string;
	readonly requests: StubRequest[];
	readonly streams: ServerResponse[];
	/** Sends one snapshot to every open event stream. */
	push(state: ControlState): void;
	/** Ends every open event stream, the way a server that goes away does. */
	dropStreams(): void;
	close(): Promise<void>;
}

const stubs: Stub[] = [];
const relays: SidebarRelay[] = [];

/** The server's three control routes, over a real socket. */
async function startStub(options: { state?: ControlState; onEvents?: (response: ServerResponse) => void } = {}): Promise<Stub> {
	const requests: StubRequest[] = [];
	const streams: ServerResponse[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(chunk as Buffer));
		request.on('end', () => {
			const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
			requests.push({
				method: request.method ?? 'GET',
				path,
				authorization: request.headers.authorization,
				body: chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined,
			});
			if (path === STATE_ROUTE) {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify(options.state ?? stateOf()));
				return;
			}
			if (path === EVENTS_ROUTE) {
				response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
				streams.push(response);
				options.onEvents?.(response);
				return;
			}
			if (path === ACTION_ROUTE) {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ ok: true }));
				return;
			}
			response.writeHead(404);
			response.end();
		});
	});
	await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
	const stub: Stub = {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		streams,
		push: state => {
			for (const stream of streams) {
				if (!stream.writableEnded && !stream.destroyed) {
					stream.write(`data: ${JSON.stringify(state)}\n\n`);
				}
			}
		},
		dropStreams: () => {
			for (const stream of streams.splice(0)) {
				stream.end();
			}
		},
		close: async () => {
			stub.dropStreams();
			await new Promise<void>(resolve => { server.close(() => resolve()); });
		},
	};
	stubs.push(stub);
	return stub;
}

function eventsOf(stub: Stub): StubRequest[] {
	return stub.requests.filter(request => request.path === EVENTS_ROUTE);
}

function actionsOf(stub: Stub): StubRequest[] {
	return stub.requests.filter(request => request.path === ACTION_ROUTE);
}

/** The window's side of the server's lifecycle, driven by hand. */
function stubLink(baseUrl: string, initial?: LinkState) {
	let current: LinkState = initial ?? { kind: 'ready', endpoint: { baseUrl, token: TOKEN }, owned: false };
	const listeners = new Set<(state: LinkState) => void>();
	const link: Pick<ServerLink, 'ensure' | 'onDidChange'> = {
		ensure: async () => current,
		onDidChange: listener => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
	return {
		link,
		change: (state: LinkState): void => {
			current = state;
			for (const listener of [...listeners]) {
				listener(state);
			}
		},
	};
}

function relayOf(link: Pick<ServerLink, 'ensure' | 'onDidChange'>, overrides: Partial<SidebarRelayDeps> = {}) {
	const deps: SidebarRelayDeps = {
		link,
		openExternal: vi.fn(async () => { }),
		copyToClipboard: vi.fn(async () => { }),
		confirmUninstall: vi.fn(async () => true),
		log: vi.fn(),
		...overrides,
	};
	const relay = new SidebarRelay(deps);
	relays.push(relay);
	const states: ControlState[] = [];
	relay.onState(state => { states.push(state); });
	return { relay, deps, states };
}

/** Lets the relay finish whatever it already started. */
async function settle(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 50));
}

afterEach(async () => {
	for (const relay of relays.splice(0)) {
		relay.dispose();
	}
	for (const stub of stubs.splice(0)) {
		await stub.close();
	}
});

describe('SidebarRelay', () => {
	it('delivers the state and then every pushed change', async () => {
		const stub = await startStub({ state: stateOf() });
		const { states } = relayOf(stubLink(stub.baseUrl).link);

		await vi.waitFor(() => { expect(states).toHaveLength(1); });
		expect(states[0].agents.map(agent => agent.id)).toEqual(['a']);
		expect(stub.requests.find(request => request.path === STATE_ROUTE)?.authorization).toBe(`Bearer ${TOKEN}`);

		stub.push(stateOf({ busy: 'Installing...' }));
		await vi.waitFor(() => { expect(states).toHaveLength(2); });
		expect(states[1].agents[0].busy).toBe('Installing...');
		expect(eventsOf(stub)[0].authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('reads a frame the stream splits across chunks', async () => {
		const split = `data: ${JSON.stringify(stateOf({ busy: 'Split across chunks' }))}\n\n`;
		const stub = await startStub({
			state: stateOf(),
			onEvents: response => {
				response.write(split.slice(0, 12));
				setTimeout(() => {
					response.write(split.slice(12, 30));
					setTimeout(() => { response.write(split.slice(30)); }, 20);
				}, 20);
			},
		});
		const { states } = relayOf(stubLink(stub.baseUrl).link);

		await vi.waitFor(() => { expect(states.some(state => state.agents[0]?.busy === 'Split across chunks')).toBe(true); });
	});

	it('forwards setSetting and install to the action route with the bearer token', async () => {
		const stub = await startStub({ state: stateOf() });
		const { relay, states } = relayOf(stubLink(stub.baseUrl).link);
		await vi.waitFor(() => { expect(states).toHaveLength(1); });

		relay.send({ type: 'setSetting', agentId: 'a', key: 'level', value: 'high' });
		relay.send({ type: 'install', agentId: 'a' });

		await vi.waitFor(() => { expect(actionsOf(stub)).toHaveLength(2); });
		const sent = actionsOf(stub).map(request => ({ authorization: request.authorization, action: JSON.parse(request.body!) as ControlAction }));
		expect(sent.map(item => item.action.type).sort()).toEqual(['install', 'setSetting']);
		expect(sent.find(item => item.action.type === 'setSetting')!.action).toEqual({ type: 'setSetting', agentId: 'a', key: 'level', value: 'high' });
		expect(sent.every(item => item.authorization === `Bearer ${TOKEN}`)).toBe(true);
	});

	it('confirms an uninstall in the window first and does not forward a declined one', async () => {
		const stub = await startStub({ state: stateOf() });
		let answer = false;
		const confirmUninstall = vi.fn(async () => answer);
		const { relay, states } = relayOf(stubLink(stub.baseUrl).link, { confirmUninstall });
		await vi.waitFor(() => { expect(states).toHaveLength(1); });

		relay.send({ type: 'uninstall', agentId: 'a' });
		await vi.waitFor(() => { expect(confirmUninstall).toHaveBeenCalledWith('Agent A'); });
		await settle();
		expect(actionsOf(stub)).toHaveLength(0);

		answer = true;
		relay.send({ type: 'uninstall', agentId: 'a' });
		await vi.waitFor(() => { expect(actionsOf(stub)).toHaveLength(1); });
		expect(JSON.parse(actionsOf(stub)[0].body!)).toEqual({ type: 'uninstall', agentId: 'a' });
	});

	it('opens the sign-in url the state holds and does not forward the action', async () => {
		const prompt = { url: 'https://example.com/device', message: 'Enter code ABCD' };
		const stub = await startStub({ state: stateOf({ signInUrl: prompt }) });
		const { relay, deps, states } = relayOf(stubLink(stub.baseUrl).link);
		await vi.waitFor(() => { expect(states).toHaveLength(1); });
		vi.mocked(deps.openExternal).mockClear();

		relay.send({ type: 'openSignInUrl', agentId: 'a' });
		await vi.waitFor(() => { expect(deps.openExternal).toHaveBeenCalledWith(prompt.url); });
		relay.send({ type: 'copySignInUrl', agentId: 'a' });
		await vi.waitFor(() => { expect(deps.copyToClipboard).toHaveBeenCalledWith(prompt.url); });

		// An agent the state does not know has no url to open.
		relay.send({ type: 'openSignInUrl', agentId: 'nope' });
		await settle();
		expect(deps.openExternal).toHaveBeenCalledTimes(1);
		expect(actionsOf(stub)).toHaveLength(0);
	});

	it('a new sign-in url opens once', async () => {
		const stub = await startStub({ state: stateOf() });
		const { deps, states } = relayOf(stubLink(stub.baseUrl).link);
		await vi.waitFor(() => { expect(states).toHaveLength(1); });
		expect(deps.openExternal).not.toHaveBeenCalled();

		const prompt = { url: 'https://example.com/device', message: 'Enter code ABCD' };
		stub.push(stateOf({ signInUrl: prompt }));
		await vi.waitFor(() => { expect(deps.openExternal).toHaveBeenCalledTimes(1); });
		expect(deps.openExternal).toHaveBeenCalledWith(prompt.url);

		stub.push(stateOf({ signInUrl: { ...prompt } }));
		await vi.waitFor(() => { expect(states).toHaveLength(3); });
		expect(deps.openExternal).toHaveBeenCalledTimes(1);
	});

	it('reconnects after the stream drops and shows the link error meanwhile', async () => {
		const stub = await startStub({ state: stateOf() });
		const { link, change } = stubLink(stub.baseUrl);
		const { states } = relayOf(link);
		await vi.waitFor(() => { expect(eventsOf(stub)).toHaveLength(1); });

		stub.dropStreams();
		change({ kind: 'unavailable', reason: 'The server is not running.' });
		await vi.waitFor(() => { expect(states.at(-1)!.agents.every(agent => agent.error === 'The server is not running.')).toBe(true); });
		expect(states.at(-1)!.agents.map(agent => agent.id)).toEqual(['a']);

		change({ kind: 'ready', endpoint: { baseUrl: stub.baseUrl, token: TOKEN }, owned: false });
		await vi.waitFor(() => { expect(eventsOf(stub)).toHaveLength(2); });
		stub.push(stateOf({ busy: 'Back' }));
		await vi.waitFor(() => { expect(states.at(-1)!.agents[0].busy).toBe('Back'); });
	});

	it('waits a second before reconnecting on its own', async () => {
		const stub = await startStub({ state: stateOf() });
		const { states } = relayOf(stubLink(stub.baseUrl).link);
		await vi.waitFor(() => { expect(eventsOf(stub)).toHaveLength(1); });

		stub.dropStreams();
		await settle();
		expect(eventsOf(stub)).toHaveLength(1);

		await vi.waitFor(() => { expect(eventsOf(stub)).toHaveLength(2); }, { timeout: 5_000 });
		expect(states.length).toBeGreaterThanOrEqual(2);
	});

	it('answers ready with the last state it delivered', async () => {
		const stub = await startStub({ state: stateOf() });
		const { relay, states } = relayOf(stubLink(stub.baseUrl).link);
		await vi.waitFor(() => { expect(states).toHaveLength(1); });

		relay.send({ type: 'ready' });
		await vi.waitFor(() => { expect(states).toHaveLength(2); });
		expect(states[1]).toEqual(states[0]);
		expect(stub.requests.filter(request => request.path === STATE_ROUTE)).toHaveLength(1);
	});

	it('delivers an empty state while the link has never been ready', async () => {
		const { link } = stubLink('http://127.0.0.1:1', { kind: 'unavailable', reason: 'The server is not running.' });
		const { states } = relayOf(link);

		await vi.waitFor(() => { expect(states).toHaveLength(1); });
		expect(states[0]).toEqual({ agents: [] });
	});
});
