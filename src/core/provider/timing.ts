/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Log } from '../logging';

/** Logs one step of a request together with the time it took. */
export type Lap = (step: string) => void;

/**
 * Starts timing a request. Each call logs the time since the previous step and
 * since the request began, under "[timing]", so a slow first message can be
 * traced to the step that spent the time.
 */
export function startLaps(log: Log, key: string): Lap {
	const start = Date.now();
	let previous = start;
	return step => {
		const now = Date.now();
		log(`[timing] ${key}: ${step} (+${now - previous}ms, ${now - start}ms since the request reached the extension)`, 'debug');
		previous = now;
	};
}
