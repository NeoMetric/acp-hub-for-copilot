/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ControlAction, ControlState, ToWebview } from './messages';

/**
 * The page's one connection to the host it runs in: actions go out, state
 * snapshots come back. A webview implements it over `postMessage` and a browser
 * page over the server's JSON routes, so the page itself knows neither.
 */
export interface ControlTransport {
	send(action: ControlAction): void;
	onState(listener: (state: ControlState) => void): () => void;
}

/** The webview's plumbing: `acquireVsCodeApi().postMessage` and the window it answers on. */
export interface WebviewChannel {
	postMessage(message: ControlAction): void;
	/** Calls `listener` with every message the host posted into this page. */
	onMessage(listener: (data: unknown) => void): void;
}

/**
 * Keeps the transport's side of a snapshot: the state, without the message that carried it. It
 * drops only `type` and passes the rest through, because a field left out here would draw a
 * sidebar that differs from the dashboard.
 */
function stateOf(message: ToWebview): ControlState {
	const { type: _carrier, ...state } = message;
	return state;
}

/** The VS Code transport, over the webview's `postMessage`. */
export function createWebviewTransport(channel: WebviewChannel): ControlTransport {
	const listeners = new Set<(state: ControlState) => void>();
	channel.onMessage(data => {
		const message = data as ToWebview | undefined;
		if (message && typeof message === 'object' && message.type === 'state') {
			for (const listener of [...listeners]) {
				listener(stateOf(message));
			}
		}
	});
	return {
		send: action => channel.postMessage(action),
		onState: listener => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
}

/** What the browser transport needs of its window; a real page passes `fetch` and `EventSource`. */
export interface HttpChannel {
	fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	eventSource(url: string): { addEventListener(type: string, listener: (event: { data: string }) => void): void; close(): void };
	/** The prefix the routes live under; the page is served from the same origin, so it is empty by default. */
	base?: string;
}

/** The server's routes. */
export const STATE_ROUTE = '/api/state';
export const ACTION_ROUTE = '/api/action';
export const EVENTS_ROUTE = '/api/events';

/**
 * The HTTP transport: the state is read once from `/api/state`, then every
 * change arrives over `/api/events`, and an action is posted to `/api/action`.
 */
export function createHttpTransport(channel: HttpChannel): ControlTransport {
	const base = channel.base ?? '';
	const listeners = new Set<(state: ControlState) => void>();
	let stream: ReturnType<HttpChannel['eventSource']> | undefined;
	let reading = false;

	const deliver = (value: unknown): void => {
		const state = value as ControlState | undefined;
		if (!state || !Array.isArray(state.agents)) {
			return;
		}
		for (const listener of [...listeners]) {
			listener(state);
		}
	};
	const read = (): void => {
		if (reading) {
			return;
		}
		reading = true;
		channel.fetch(`${base}${STATE_ROUTE}`)
			.then(async response => { if (response.ok) { deliver(await response.json()); } })
			.catch(() => undefined)
			.finally(() => { reading = false; });
	};

	return {
		send: action => {
			void channel.fetch(`${base}${ACTION_ROUTE}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(action),
			}).catch(() => undefined);
		},
		onState: listener => {
			listeners.add(listener);
			if (!stream) {
				stream = channel.eventSource(`${base}${EVENTS_ROUTE}`);
				stream.addEventListener('message', event => {
					try {
						deliver(JSON.parse(event.data));
					} catch {
						// A frame that is not a state is not this page's to read.
					}
				});
				read();
			}
			return () => {
				if (listeners.delete(listener) && listeners.size === 0) {
					stream?.close();
					stream = undefined;
				}
			};
		},
	};
}
