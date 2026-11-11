/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, SERVER_PORT, isPort, serverPortOf } from '../../src/hosts/http/config';
import type { ConfigReader } from '../../src/engine/ports/state';

function configOf(value: unknown): ConfigReader {
	return { get: <T>(section: string) => (section === SERVER_PORT ? value : undefined) as T | undefined };
}

describe('the server port setting', () => {
	it('is stored under server.port and defaults to 8791', () => {
		expect(SERVER_PORT).toBe('server.port');
		expect(DEFAULT_PORT).toBe(8791);
		expect(serverPortOf(configOf(undefined))).toBe(8791);
	});

	it('reads a valid saved port', () => {
		expect(serverPortOf(configOf(9000))).toBe(9000);
	});

	it.each([0, -1, 65_536, 70_000, 80.5, '80', null, Number.NaN])('reads %s as the default', value => {
		expect(serverPortOf(configOf(value))).toBe(DEFAULT_PORT);
	});

	it('accepts only integers from 1 to 65535', () => {
		expect(isPort(1)).toBe(true);
		expect(isPort(65_535)).toBe(true);
		expect(isPort(0)).toBe(false);
		expect(isPort(65_536)).toBe(false);
		expect(isPort(1.5)).toBe(false);
		expect(isPort('8791')).toBe(false);
	});
});
