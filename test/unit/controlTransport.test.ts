/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessComposition } from '../../src/composition/headless';
import type { AgentAdapter } from '../../src/core/adapter';
import type { InstallState } from '../../src/core/installers';
import type { ControlSurface } from '../../src/engine/control/ControlService';
import type { HostPort } from '../../src/engine/ports/host';
import { createServer } from '../../src/hosts/http/server';
import type { ControlAction, ControlState } from '../../src/ui/messages';
import { mountPage } from '../../src/ui/page';
import { renderCards } from '../../src/ui/render';
import { ACTION_ROUTE, createHttpTransport, createWebviewTransport, EVENTS_ROUTE, STATE_ROUTE } from '../../src/ui/transport';

const BUNDLE = path.resolve(__dirname, '..', 'fixtures', 'page-bundle.js');
const STYLE = path.resolve(__dirname, '..', '..', 'media', 'sidebar.css');

/** The page's root without a DOM: it keeps the HTML it was given and the listeners it was wired with. */
class FakeRoot {
	innerHTML = '';
	private readonly listeners = new Map<string, (event: unknown) => void>();

	addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, listener);
	}

	/** Clicks the element a fake event would report, the way a button inside the page does. */
	click(element: unknown): void {
		this.listeners.get('click')?.({ target: element });
	}
}

/** The state both transports must draw identically. */
const SAMPLE: ControlState = {
	agents: [
		{
			id: 'a',
			displayName: 'Agent A',
			install: 'installed',
			removable: true,
			signedIn: 'yes',
			hasSavedKey: false,
			enabled: true,
			visible: true,
			settings: [{ key: 'level', label: 'Level', description: 'How hard it works.', type: 'enum', value: 'high', options: ['low', 'high'] }],
			usage: { status: 'ok', windows: [{ label: '5h', usedPercent: 40, resets: 'in 2h' }], plan: 'Pro' },
		},
		{
			id: 'b',
			displayName: 'Agent B',
			install: 'installing',
			installPercent: 30,
			removable: false,
			signedIn: 'unknown',
			hasSavedKey: false,
			enabled: false,
			visible: true,
			settings: [],
			usage: { status: 'unsupported', windows: [] },
		},
	],
	globalSettings: [
		{ key: 'resume.transcriptDetail', label: 'Restored chat detail', description: '', type: 'enum', value: 'full', options: ['compact', 'full'] },
	],
};

/** The VS Code end: a channel that records what the page posts and delivers what the host would. */
function webviewChannel() {
	const posted: ControlAction[] = [];
	let deliver: ((data: unknown) => void) | undefined;
	const transport = createWebviewTransport({
		postMessage: message => { posted.push(message); },
		onMessage: listener => { deliver = listener; },
	});
	const state = (value: ControlState): void => { deliver?.({ type: 'state', ...value }); };
	return { transport, posted, state };
}

/** The browser end: a channel whose state comes from `GET /api/state` and whose actions are POSTed. */
function httpChannel(state: ControlState) {
	const requests: Array<{ url: string; method: string; body?: string }> = [];
	const listeners: Array<(event: { data: string }) => void> = [];
	let closed = false;
	const transport = createHttpTransport({
		fetch: async (url, init) => {
			requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
			return {
				ok: true,
				status: 200,
				json: async () => url === STATE_ROUTE ? state : { ok: true },
			};
		},
		eventSource: url => {
			requests.push({ url, method: 'SSE' });
			return {
				addEventListener: (_type, listener) => { listeners.push(listener); },
				close: () => { closed = true; },
			};
		},
	});
	const push = (value: ControlState): void => {
		for (const listener of listeners) {
			listener({ data: JSON.stringify(value) });
		}
	};
	return { transport, requests, push, isClosed: () => closed };
}

function adapter(id: string): AgentAdapter {
	return {
		id,
		displayName: `Agent ${id}`,
		install: { kind: 'npm' },
		auth: [],
		settings: [],
	} as unknown as AgentAdapter;
}

/** The sidebar's operations, over two agents whose install state changes as they are installed. */
function fakeControl(overrides: Partial<ControlSurface> = {}) {
	const installed = new Map<string, InstallState>([['a', 'not-installed'], ['b', 'not-installed']]);
	const control: ControlSurface = {
		agents: () => [adapter('a'), adapter('b')],
		visibleAgents: () => ['a', 'b'],
		saveVisibleAgents: async () => { },
		installState: async id => installed.get(id) ?? 'not-installed',
		install: vi.fn(async (id: string) => { installed.set(id, 'installed'); }),
		uninstall: vi.fn(async (id: string) => { installed.set(id, 'not-installed'); return true; }),
		isSignedIn: async () => undefined,
		hasSavedKey: async () => false,
		signIn: async () => ({ ok: true }),
		saveApiKey: async () => ({ ok: true }),
		signOut: async () => { },
		readSettings: () => ({}),
		writeSetting: vi.fn(async () => { }),
		readGlobalSetting: () => undefined,
		writeGlobalSetting: vi.fn(async () => { }),
		isEnabled: () => true,
		setEnabled: async () => { },
		usage: () => ({ status: 'idle', extraWindows: [] }),
		refreshUsage: async () => { },
		refresh: () => { },
		onUsageChange: () => ({ dispose() { } }),
		...overrides,
	};
	return { control, installed };
}

const cleanups: Array<() => Promise<void>> = [];

/** The real server over a fake control service; the chat surface needs no agent for these routes. */
async function start(control: ControlSurface | undefined, token?: string): Promise<string> {
	const composition = {
		host: { log: () => undefined } as unknown as HostPort,
		adapters: [],
		serviceOf: () => undefined,
		close: async () => { },
	} as HeadlessComposition;
	const server = createServer({
		composition,
		token,
		page: control ? { control, bundle: BUNDLE, style: STYLE } : undefined,
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	cleanups.push(async () => {
		const closed = new Promise<void>(resolve => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
	});
	return `http://127.0.0.1:${address.port}`;
}

/** The `data:` payloads of an SSE body, in order. */
function payloadsOf(text: string): string[] {
	return text.split('\n\n')
		.map(part => part.trim())
		.filter(part => part.startsWith('data:'))
		.map(part => part.slice('data:'.length).trim());
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

describe('the control transport', () => {
	it('draws the same DOM from the same state in both hosts', async () => {
		const webviewRoot = new FakeRoot();
		const webview = webviewChannel();
		mountPage(webview.transport, webviewRoot as unknown as HTMLElement);
		webview.state(SAMPLE);

		const httpRoot = new FakeRoot();
		const http = httpChannel(SAMPLE);
		mountPage(http.transport, httpRoot as unknown as HTMLElement);
		await vi.waitFor(() => expect(httpRoot.innerHTML).not.toBe(''));

		expect(webviewRoot.innerHTML).toBe(renderCards(SAMPLE.agents, new Set(), SAMPLE.globalSettings ?? []));
		expect(httpRoot.innerHTML).toBe(webviewRoot.innerHTML);
	});

	it('draws the server strip in both hosts, which is what the sidebar was missing', async () => {
		const withServer: ControlState = {
			...SAMPLE,
			server: { port: 8791, savedPort: 8791, url: 'http://127.0.0.1:8791/?token=abc', portFromEnv: false, alive: true },
		};

		const webviewRoot = new FakeRoot();
		const webview = webviewChannel();
		mountPage(webview.transport, webviewRoot as unknown as HTMLElement);
		webview.state(withServer);

		const httpRoot = new FakeRoot();
		const http = httpChannel(withServer);
		mountPage(http.transport, httpRoot as unknown as HTMLElement);
		await vi.waitFor(() => expect(httpRoot.innerHTML).toContain('server-status'));

		expect(webviewRoot.innerHTML).toContain('status-dot alive');
		expect(webviewRoot.innerHTML).toContain('127.0.0.1:8791');
		expect(webviewRoot.innerHTML).toBe(httpRoot.innerHTML);
	});

	it('delivers the Models fields of a snapshot in both hosts', async () => {
		const withModels: ControlState = { ...SAMPLE, models: { agents: [{ agentId: 'a', provider: { name: 'A', default: 'A' }, models: [] }] }, notice: 'Reload it.', refreshing: true };

		const webview = webviewChannel();
		const fromWebview: ControlState[] = [];
		webview.transport.onState(state => { fromWebview.push(state); });
		webview.state(withModels);
		expect(fromWebview[0]).toEqual(withModels);

		const http = httpChannel(withModels);
		const fromHttp: ControlState[] = [];
		http.transport.onState(state => { fromHttp.push(state); });
		await vi.waitFor(() => expect(fromHttp[0]).toEqual(withModels));
	});

	it('draws a change the host sends after the first snapshot', async () => {
		const root = new FakeRoot();
		const http = httpChannel(SAMPLE);
		mountPage(http.transport, root as unknown as HTMLElement);
		await vi.waitFor(() => expect(root.innerHTML).toContain('Agent A'));

		const changed: ControlState = { agents: SAMPLE.agents.map(agent => agent.id === 'a' ? { ...agent, displayName: 'Renamed' } : agent) };
		http.push(changed);

		expect(root.innerHTML).toContain('Renamed');
		expect(root.innerHTML).not.toContain('Agent A');
	});

	it('round-trips one action over each transport', async () => {
		const webviewRoot = new FakeRoot();
		const webview = webviewChannel();
		mountPage(webview.transport, webviewRoot as unknown as HTMLElement);
		webviewRoot.click({ closest: () => ({ disabled: false, dataset: { action: 'install', agent: 'a' } }) });
		expect(webview.posted).toContainEqual({ type: 'install', agentId: 'a' });

		const httpRoot = new FakeRoot();
		const http = httpChannel(SAMPLE);
		mountPage(http.transport, httpRoot as unknown as HTMLElement);
		httpRoot.click({ closest: () => ({ disabled: false, dataset: { action: 'install', agent: 'a' } }) });

		await vi.waitFor(() => expect(http.requests.filter(request => request.url === ACTION_ROUTE && request.method === 'POST')).toHaveLength(2));
		const posted = http.requests.filter(request => request.url === ACTION_ROUTE).map(request => JSON.parse(request.body ?? 'null'));
		expect(posted).toEqual([{ type: 'ready' }, { type: 'install', agentId: 'a' }]);
	});

	it('stops the event stream when the page lets go of it', async () => {
		const http = httpChannel(SAMPLE);
		const unsubscribe = http.transport.onState(() => undefined);
		expect(http.requests.some(request => request.url === EVENTS_ROUTE)).toBe(true);
		unsubscribe();
		expect(http.isClosed()).toBe(true);
	});

	it('serves the page and its bundle', async () => {
		const url = await start(fakeControl().control);

		const page = await fetch(`${url}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toContain('text/html');
		expect(await page.text()).toContain('<div id="root"></div>');

		const bundle = await fetch(`${url}/sidebar.js`);
		expect(bundle.status).toBe(200);
		expect(await bundle.text()).toContain('fake page bundle');

		const style = await fetch(`${url}/sidebar.css`);
		expect(style.status).toBe(200);
		expect(style.headers.get('content-type')).toContain('text/css');
	});

	it('trades /?token= for a cookie that lets a browser use the page without the header', async () => {
		const url = await start(fakeControl().control, 'se cret/1');

		expect((await fetch(`${url}/`)).status).toBe(401);
		expect((await fetch(`${url}/?token=wrong`)).status).toBe(401);

		const signIn = await fetch(`${url}/?token=${encodeURIComponent('se cret/1')}`, { redirect: 'manual' });
		expect(signIn.status).toBe(302);
		expect(signIn.headers.get('location')).toBe('/');
		const cookie = signIn.headers.get('set-cookie') ?? '';
		expect(cookie).toMatch(/HttpOnly/);
		expect(cookie).toMatch(/SameSite=Strict/);

		const headers = { Cookie: cookie.split(';')[0] };
		expect((await fetch(`${url}/`, { headers })).status).toBe(200);
		expect((await fetch(`${url}${STATE_ROUTE}`, { headers })).status).toBe(200);
		expect((await fetch(`${url}${STATE_ROUTE}`, { headers: { Cookie: 'acp_hub_token=wrong' } })).status).toBe(401);
	});

	it('does not let a page from another origin use the cookie, though the header still works', async () => {
		const url = await start(fakeControl().control, 'secret');
		const cookie = { Cookie: 'acp_hub_token=secret' };
		const send = (headers: Record<string, string>) => fetch(`${url}${ACTION_ROUTE}`, {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain', ...headers },
			body: JSON.stringify({ type: 'ready' }),
		});

		expect((await send({ ...cookie })).status).toBe(200);
		expect((await send({ ...cookie, Origin: url })).status).toBe(200);
		expect((await send({ ...cookie, Origin: 'http://127.0.0.1:1' })).status).toBe(401);
		expect((await send({ ...cookie, Origin: 'null' })).status).toBe(401);
		expect((await send({ Authorization: 'Bearer secret', Origin: 'http://127.0.0.1:1' })).status).toBe(200);
	});

	it('answers /api/state and runs an action sent to /api/action', async () => {
		const { control } = fakeControl();
		const url = await start(control);

		const before = await (await fetch(`${url}${STATE_ROUTE}`)).json() as ControlState;
		expect(before.agents.map(agent => [agent.id, agent.install])).toEqual([['a', 'not-installed'], ['b', 'not-installed']]);
		expect(before.globalSettings?.map(setting => setting.key)).toContain('resume.transcriptDetail');

		const response = await fetch(`${url}${ACTION_ROUTE}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'install', agentId: 'a' }),
		});
		expect(response.status).toBe(200);
		expect(control.install).toHaveBeenCalledWith('a', expect.any(Function));

		const after = await (await fetch(`${url}${STATE_ROUTE}`)).json() as ControlState;
		expect(after.agents.find(agent => agent.id === 'a')!.install).toBe('installed');
	});

	it('streams the state over /api/events', async () => {
		const { control } = fakeControl();
		const url = await start(control);

		const response = await fetch(`${url}${EVENTS_ROUTE}`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const reader = response.body!.getReader();
		const first = await reader.read();
		const text = new TextDecoder().decode(first.value);
		await reader.cancel();

		const state = JSON.parse(payloadsOf(text)[0]) as ControlState;
		expect(state.agents.map(agent => agent.id)).toEqual(['a', 'b']);
	});

	it('rejects an action that is not a control action', async () => {
		const url = await start(fakeControl().control);

		const response = await fetch(`${url}${ACTION_ROUTE}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ nothing: true }),
		});

		expect(response.status).toBe(400);
	});
});
describe('the webview transport', () => {
	it('carries the usage view from the message into the page state', () => {
		let deliver: ((data: unknown) => void) | undefined;
		const transport = createWebviewTransport({ postMessage: () => { }, onMessage: listener => { deliver = listener; } });
		const received: ControlState[] = [];
		transport.onState(state => received.push(state));
		const usage = {
			retentionDays: 7,
			agents: [{ id: 'a', name: 'A' }],
			workspaces: [],
			days: [],
			weeks: [],
			today: [],
			empty: true,
		};
		deliver?.({ type: 'state', agents: [], usage });
		expect(received[0]?.usage).toEqual(usage);
	});

	it('carries the server view from the message into the page state, as the browser gets it', () => {
		let deliver: ((data: unknown) => void) | undefined;
		const transport = createWebviewTransport({ postMessage: () => { }, onMessage: listener => { deliver = listener; } });
		const received: ControlState[] = [];
		transport.onState(state => received.push(state));
		const server = { port: 8791, savedPort: 8791, url: 'http://127.0.0.1:8791/?token=abc', portFromEnv: false, alive: true };

		deliver?.({ type: 'state', agents: [], server });

		expect(received[0]?.server).toEqual(server);
	});

	it('carries the reason the host reaches no server, and whether it is starting one', () => {
		let deliver: ((data: unknown) => void) | undefined;
		const transport = createWebviewTransport({ postMessage: () => { }, onMessage: listener => { deliver = listener; } });
		const received: ControlState[] = [];
		transport.onState(state => received.push(state));

		deliver?.({ type: 'state', agents: [], linkError: 'The server is not running.', starting: true });

		expect(received[0]?.linkError).toBe('The server is not running.');
		expect(received[0]?.starting).toBe(true);
	});
});
