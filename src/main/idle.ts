/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Server } from 'node:http';

/** How often the server checks whether it has been left alone long enough. */
const CHECK_INTERVAL_MS = 30_000;

export interface IdleWatchOptions {
	/** How long without any request, and with none in flight, before `onIdle` runs. */
	readonly idleMs: number;
	readonly onIdle: () => void;
	readonly intervalMs?: number;
	readonly now?: () => number;
}

/**
 * Calls `onIdle` once, when no request has arrived for `idleMs` and none is still
 * being answered. A window checks the server every half minute while it is open,
 * so only a server no window uses stops. Returns the function that ends the watch.
 */
export function watchIdle(server: Server, options: IdleWatchOptions): () => void {
	const now = options.now ?? Date.now;
	let lastActivity = now();
	let active = 0;
	server.on('request', (_request, response) => {
		active += 1;
		lastActivity = now();
		response.once('close', () => {
			active -= 1;
			lastActivity = now();
		});
	});
	const timer = setInterval(() => {
		if (active === 0 && now() - lastActivity >= options.idleMs) {
			clearInterval(timer);
			options.onIdle();
		}
	}, options.intervalMs ?? CHECK_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** The idle limit `ACP_HUB_IDLE_MINUTES` names in milliseconds; 0 when it is absent, zero or not a number, meaning never. */
export function idleMsOf(value: string | undefined): number {
	const minutes = Number(value?.trim());
	return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;
}
