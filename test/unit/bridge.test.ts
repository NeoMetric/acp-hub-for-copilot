/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { McpBridge, limitTextContent, toMcpContent, type McpServerEndpoint, type McpToolExecutor } from '../../src/core/bridge';
import { LanguageModelDataPart, LanguageModelTextPart } from './vscode-mock';

const tools = [
	{ name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
] as unknown as vscode.LanguageModelChatTool[];

describe('McpBridge', () => {
	let bridge: McpBridge;
	let endpoint: McpServerEndpoint;
	const execute = vi.fn<McpToolExecutor>();
	const logs: string[] = [];

	beforeEach(async () => {
		execute.mockReset();
		logs.length = 0;
		bridge = new McpBridge(message => logs.push(message));
		endpoint = await bridge.registerSession(tools, execute);
	});

	afterEach(() => bridge.dispose());

	const post = (body: unknown, headers: Record<string, string> = {}) => fetch(endpoint.url, {
		method: 'POST',
		headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});

	const rpc = async (method: string, params?: unknown) => (await post({ jsonrpc: '2.0', id: 1, method, params })).json() as Promise<Record<string, any>>;

	it('only listens on loopback and hands out a bearer token', () => {
		expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(endpoint.token).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('rejects requests without a valid token', async () => {
		const missing = await fetch(endpoint.url, { method: 'POST', body: '{}' });
		const wrong = await fetch(endpoint.url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
		const unregistered = (() => { bridge.unregisterSession(endpoint.token); return post({ jsonrpc: '2.0', id: 1, method: 'ping' }); })();

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect((await unregistered).status).toBe(401);
	});

	it('refuses browser-style requests that carry an Origin or a foreign Host', async () => {
		const withOrigin = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
		expect(withOrigin.status).toBe(403);

		const foreignHost = await new Promise<number>((resolve, reject) => {
			const url = new URL(endpoint.url);
			const request = http.request({ host: url.hostname, port: url.port, method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${endpoint.token}` } }, response => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
			request.on('error', reject);
			request.end('{}');
		});
		expect(foreignHost).toBe(403);
	});

	it('keeps one of the two methods and refuses the rest', async () => {
		const put = await fetch(endpoint.url, { method: 'PUT', headers: { authorization: `Bearer ${endpoint.token}` } });
		const del = await fetch(endpoint.url, { method: 'DELETE', headers: { authorization: `Bearer ${endpoint.token}` } });

		expect(put.status).toBe(405);
		expect(del.status).toBe(405);
		expect(put.headers.get('allow')).toBe('GET, POST');
	});

	it('answers initialize with a known protocol version and tool capability', async () => {
		const body = await rpc('initialize', { protocolVersion: '2025-03-26' });

		expect(body.result.protocolVersion).toBe('2025-03-26');
		expect(body.result.capabilities).toEqual({ tools: { listChanged: true } });
		expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-06-18');
	});

	it('lists the tools of its own session', async () => {
		const body = await rpc('tools/list');

		expect(body.result.tools).toEqual([{ name: 'read_file', description: 'Reads a file', inputSchema: tools[0].inputSchema }]);
	});

	it('lists the same tools in the same order however Copilot orders them', async () => {
		const two = [{ name: 'b', description: '' }, { name: 'a', description: '' }] as unknown as vscode.LanguageModelChatTool[];
		bridge.updateTools(endpoint.token, two);
		const first = JSON.stringify((await rpc('tools/list')).result);
		bridge.updateTools(endpoint.token, [...two].reverse());

		expect(JSON.stringify((await rpc('tools/list')).result)).toBe(first);
		expect((await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['a', 'b', 'read_file']);
	});

	it('keeps listing a withdrawn tool, so the agent\'s cached tool block stays, but refuses to run it', async () => {
		bridge.updateTools(endpoint.token, []);

		expect((await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_file']);
		expect((await rpc('tools/call', { name: 'read_file' })).result.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it('stays quiet when a tool is withdrawn', () => {
		bridge.updateTools(endpoint.token, []);

		expect(logs.filter(line => line.includes('Tool set of an agent session grew'))).toHaveLength(0);
	});

	it('tells an open notification stream that the tool list changed, so an enabled tool starts being offered', async () => {
		const response = await fetch(endpoint.url, { headers: { authorization: `Bearer ${endpoint.token}` } });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let seen = '';
		const readUntil = async (needle: string) => {
			while (!seen.includes(needle)) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				seen += decoder.decode(value, { stream: true });
			}
			return seen;
		};

		await readUntil('waiting for notifications');
		bridge.updateTools(endpoint.token, [{ name: 'write_file', description: '' }] as unknown as vscode.LanguageModelChatTool[]);
		expect(await readUntil('notifications/tools/list_changed')).toContain('notifications/tools/list_changed');

		await reader.cancel();
	});

	it('keeps writing to an idle notification stream, so the agent does not take it for a dead connection', async () => {
		bridge.dispose();
		bridge = new McpBridge(message => logs.push(message), 20);
		endpoint = await bridge.registerSession(tools, execute);

		const response = await fetch(endpoint.url, { headers: { authorization: `Bearer ${endpoint.token}` } });
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let seen = '';
		const deadline = Date.now() + 2_000;
		while (seen.split(': ping').length < 3 && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			seen += decoder.decode(value, { stream: true });
		}

		expect(seen.split(': ping').length - 1).toBeGreaterThanOrEqual(2);
		await reader.cancel();
	});

	it('stops the heartbeat when the stream closes', async () => {
		bridge.dispose();
		bridge = new McpBridge(message => logs.push(message), 20);
		endpoint = await bridge.registerSession(tools, execute);
		const clear = vi.spyOn(globalThis, 'clearInterval');

		const response = await fetch(endpoint.url, { headers: { authorization: `Bearer ${endpoint.token}` } });
		const reader = response.body!.getReader();
		await reader.read();
		bridge.unregisterSession(endpoint.token);
		await expect(reader.read()).resolves.toMatchObject({ done: true });

		await vi.waitFor(() => expect(clear).toHaveBeenCalled());
		clear.mockRestore();
	});

	it('stays quiet when the same tools arrive again in another order', () => {
		const two = [{ name: 'a', description: '' }, { name: 'b', description: '' }] as unknown as vscode.LanguageModelChatTool[];
		bridge.updateTools(endpoint.token, two);
		bridge.updateTools(endpoint.token, [...two].reverse());

		expect(logs.filter(line => line.includes('Tool set of an agent session grew'))).toHaveLength(1);
	});

	it('drops the notification stream when its session goes away', async () => {
		const response = await fetch(endpoint.url, { headers: { authorization: `Bearer ${endpoint.token}` } });
		const reader = response.body!.getReader();
		await reader.read();

		bridge.unregisterSession(endpoint.token);

		await expect(reader.read()).resolves.toMatchObject({ done: true });
	});

	it('forwards a tool call to the executor and returns its content', async () => {
		execute.mockResolvedValue({ content: [new LanguageModelTextPart('file contents')] });

		const body = await rpc('tools/call', { name: 'read_file', arguments: { path: 'a.txt' } });

		expect(execute).toHaveBeenCalledWith('read_file', { path: 'a.txt' }, expect.anything());
		expect(body.result).toEqual({ content: [{ type: 'text', text: 'file contents' }] });
	});

	it('passes the error flag through', async () => {
		execute.mockResolvedValue({ content: [new LanguageModelTextPart('denied')], isError: true });

		expect((await rpc('tools/call', { name: 'read_file' })).result.isError).toBe(true);
	});

	it('refuses to run a tool itself when no response can own the call', async () => {
		execute.mockResolvedValue(undefined);

		const body = await rpc('tools/call', { name: 'read_file' });

		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toContain('The user cancelled the tool call.');
	});

	it('reports an executor failure as a tool error', async () => {
		execute.mockRejectedValue(new Error('cancelled by user'));

		const body = await rpc('tools/call', { name: 'read_file' });

		expect(body.result).toEqual({ content: [{ type: 'text', text: 'cancelled by user' }], isError: true });
	});

	it('does not run tools outside the session or without a name', async () => {
		const unknown = await rpc('tools/call', { name: 'delete_everything' });
		expect(unknown.result.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();

		const nameless = await rpc('tools/call', {});
		expect(nameless.error.code).toBe(-32602);
	});

	it('handles ping, unknown methods, notifications, batches and bad JSON', async () => {
		expect((await rpc('ping')).result).toEqual({});
		expect((await rpc('resources/list')).error.code).toBe(-32601);

		const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(notification.status).toBe(202);

		const batch = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])).json() as unknown[];
		expect(batch).toHaveLength(2);

		const bad = await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: '{not json' });
		expect((await bad.json() as { error: { code: number } }).error.code).toBe(-32700);
	});

	it('rejects an oversized body', async () => {
		const response = await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: 'x'.repeat(9 * 1024 * 1024) }).catch(() => undefined);

		// The server may either answer 413 or drop the connection once the limit is hit.
		expect(response === undefined || response.status === 413).toBe(true);
	});

	it('does not accept sessions after disposal', async () => {
		bridge.dispose();

		await expect(bridge.registerSession(tools, execute)).rejects.toThrow('disposed');
	});
});

describe('limitTextContent', () => {
	const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');

	it('passes a result within the limit untouched', () => {
		const content = [{ type: 'text', text: lines }];

		expect(limitTextContent(content, lines.length)).toBe(content);
	});

	it('cuts at a line end and says how much was shown', () => {
		const [shown, note] = limitTextContent([{ type: 'text', text: lines }], 25);

		expect(shown).toEqual({ type: 'text', text: 'line 0\nline 1\nline 2' });
		expect(note.text).toContain(`[Output cut: 20 of ${lines.length} characters shown.`);
	});

	it('counts all text blocks together and keeps images', () => {
		const image = { type: 'image', data: 'AQI=', mimeType: 'image/png' };

		const limited = limitTextContent([{ type: 'text', text: 'aaaa' }, image, { type: 'text', text: 'bbbb' }, { type: 'text', text: 'cccc' }], 6);

		expect(limited.slice(0, 3)).toEqual([{ type: 'text', text: 'aaaa' }, image, { type: 'text', text: 'bb' }]);
		expect(limited).toHaveLength(4);
	});
});

describe('McpBridge result limit', () => {
	let bridge: McpBridge;

	afterEach(() => bridge.dispose());

	const call = async (maxResultChars: number | undefined) => {
		bridge = new McpBridge(() => undefined);
		const execute = vi.fn<McpToolExecutor>().mockResolvedValue({ content: [new LanguageModelTextPart('x'.repeat(100))] });
		const endpoint = await bridge.registerSession(tools, execute, { maxResultChars });
		const response = await fetch(endpoint.url, {
			method: 'POST',
			headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file' } }),
		});
		return (await response.json() as { result: { content: Array<{ text: string }> } }).result.content;
	};

	it('cuts a long result for a session that has a limit', async () => {
		const content = await call(40);

		expect(content[0].text).toHaveLength(40);
		expect(content[1].text).toContain('40 of 100 characters shown');
	});

	it('returns the whole result when the session has no limit', async () => {
		expect(await call(undefined)).toEqual([{ type: 'text', text: 'x'.repeat(100) }]);
	});
});

describe('toMcpContent', () => {
	it('maps text, images, other data, strings and arbitrary values', () => {
		const content = toMcpContent([
			new LanguageModelTextPart('hi'),
			new LanguageModelDataPart(new Uint8Array([1, 2]), 'image/png'),
			new LanguageModelDataPart(new TextEncoder().encode('{"a":1}'), 'application/json'),
			'plain',
			{ any: 'thing' },
			undefined,
		]);

		expect(content).toEqual([
			{ type: 'text', text: 'hi' },
			{ type: 'image', data: 'AQI=', mimeType: 'image/png' },
			{ type: 'text', text: '{"a":1}' },
			{ type: 'text', text: 'plain' },
			{ type: 'text', text: '{"any":"thing"}' },
		]);
	});
});
