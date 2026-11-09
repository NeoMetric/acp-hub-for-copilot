/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { API_VERSION, SERVER_NAME, type HealthWire } from '../../../src/hosts/http/wire';
import { closeServers, mockAdapter, start } from './serverHarness';

const adapter = mockAdapter();

afterEach(closeServers);

describe('the wire contract', () => {
	it('health reports the server identity', async () => {
		const { url } = await start([{ adapter }]);

		const response = await fetch(`${url}/health`);

		expect(response.status).toBe(200);
		const body = await response.json() as HealthWire;
		expect(body.name).toBe(SERVER_NAME);
		expect(body.name).toBe('acp-hub');
		expect(body.apiVersion).toBe(API_VERSION);
		expect(typeof body.version).toBe('string');
		expect(body.status).toBe('ok');
		expect(body.openSessions).toBe(0);
		expect(body.agents).toEqual([expect.objectContaining({ id: adapter.id, installed: true, openSessions: 0 })]);
	});
});
