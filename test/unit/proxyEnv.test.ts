/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { proxyEnvironment, proxyUrlOf } from '../../src/hosts/vscode/proxyEnv';

describe('the proxy the agents are started with', () => {
	it('names both schemes, and the bypass list the setting holds', () => {
		expect(proxyEnvironment({ url: 'http://127.0.0.1:7897', noProxy: '127.0.0.1,localhost' })).toEqual({
			HTTP_PROXY: 'http://127.0.0.1:7897',
			HTTPS_PROXY: 'http://127.0.0.1:7897',
			NO_PROXY: '127.0.0.1,localhost',
		});
	});

	it('reads a proxy written as host:port, which is how a local one is usually named', () => {
		expect(proxyEnvironment({ url: ' 127.0.0.1:7897 ', noProxy: '' }).HTTPS_PROXY).toBe('http://127.0.0.1:7897');
	});

	it('sets no variables at all when no proxy is configured', () => {
		expect(proxyEnvironment({ url: '', noProxy: '127.0.0.1,localhost' })).toEqual({});
		expect(proxyEnvironment({ url: '   ', noProxy: '' })).toEqual({});
	});

	it('leaves the bypass list out when it is empty', () => {
		expect(proxyEnvironment({ url: 'http://127.0.0.1:7897', noProxy: '  ' })).toEqual({
			HTTP_PROXY: 'http://127.0.0.1:7897',
			HTTPS_PROXY: 'http://127.0.0.1:7897',
		});
	});

	it('ignores a value that names no usable proxy, so the agent is started without one', () => {
		for (const value of ['::::', 'http://', 'ftp://proxy.corp:3128', 'not a url']) {
			expect(proxyUrlOf(value), value).toBeUndefined();
			expect(proxyEnvironment({ url: value, noProxy: '' }), value).toEqual({});
		}
	});

	it('keeps the credentials a proxy URL carries', () => {
		expect(proxyUrlOf('http://user:secret@proxy.corp:3128')).toBe('http://user:secret@proxy.corp:3128');
	});

	it('accepts socks5, which the agents also read', () => {
		expect(proxyUrlOf('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
	});
});
