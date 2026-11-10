/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WARM_ROUTE } from '../http/wire';
import type { ServerEndpoint } from './serverLink';

/**
 * Asks the server to start its agents, so the first chat does not wait for them.
 * Returns the agents the server is starting; the server does not wait for them to finish.
 */
export async function warmAgents(endpoint: ServerEndpoint, fetchOf: typeof fetch = fetch): Promise<string[]> {
	const response = await fetchOf(`${endpoint.baseUrl}${WARM_ROUTE}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) },
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) {
		throw new Error(`The server answered HTTP ${response.status}.`);
	}
	const body = await response.json() as { agents?: unknown };
	return Array.isArray(body.agents) ? body.agents.filter((id): id is string => typeof id === 'string') : [];
}
