/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeadlessComposition } from '../../src/composition/headless';
import type { AgentAdapter } from '../../src/core/adapter';
import { ChatService } from '../../src/engine/chat/ChatService';
import type { ToolBridge } from '../../src/engine/chat/types';
import { createHeadlessHost } from '../../src/hosts/http/host';
import { createServer } from '../../src/hosts/http/server';

const MOCK_AGENT = path.resolve(__dirname, '..', 'fixtures', 'mock-acp-agent.cjs');
const NO_LOG = (): void => undefined;

/** The mock ACP agent, which streams "hello" and ends its turn. */
const adapter: AgentAdapter = {
	id: 'mock',
	displayName: 'Mock',
	vendor: 'acphub-mock',
	install: { kind: 'existing-cli', command: 'node' },
	launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: 'normal' } }),
	auth: [],
	settings: [],
	modelPolicy: {} as AgentAdapter['modelPolicy'],
	systemPrompt: { toolAccess: '', listRequiredArguments: false },
};

/** A bridge that hands out an endpoint and runs nothing; the HTTP client runs the tools. */
const noTools: ToolBridge = {
	registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
	updateTools: () => undefined,
	unregisterSession: () => undefined,
};

const cleanups: Array<() => Promise<void>> = [];

/** Starts the server on a free port over the mock agent, with a store root of its own. */
async function start(token?: string): Promise<string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-server-'));
	const host = createHeadlessHost({ root, log: NO_LOG });
	const service = new ChatService({
		adapter,
		host,
		bridge: noTools,
		resolveLaunch: () => Promise.resolve({ entryPath: MOCK_AGENT, installDir: '', storageDir: path.join(root, 'agent'), workspaceFolder: root, settings: {} }),
	});
	const composition: HeadlessComposition = {
		host,
		adapters: [adapter],
		serviceOf: id => id === adapter.id ? service : undefined,
		close: () => service.close(),
	};
	const server = createServer({ composition, token });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	cleanups.push(async () => {
		const closed = new Promise<void>(resolve => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
		await composition.close();
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	return `http://127.0.0.1:${address.port}`;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

/** One OpenAI chat request, as a stock client writes it. */
function chat(model: string, text = 'hi'): Record<string, unknown> {
	return { model, messages: [{ role: 'user', content: text }] };
}

/** The first model the mock agent offers, as the endpoint publishes it. */
async function firstModel(url: string): Promise<string> {
	const response = await fetch(`${url}/v1/models`);
	const body = await response.json() as { data: Array<{ id: string }> };
	const model = body.data.find(entry => entry.id.startsWith(`${adapter.id}/`));
	expect(model, 'the mock agent offers a model').toBeDefined();
	return model!.id;
}

/** The `data:` payloads of an SSE response, in order. */
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

describe('the HTTP server', () => {
	it('answers a completion with the assistant text', async () => {
		const url = await start();
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, chat(model));

		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.object).toBe('chat.completion');
		expect(body.model).toBe(model);
		expect(body.choices[0].message.role).toBe('assistant');
		expect(body.choices[0].message.content).toBe('hello');
		expect(body.choices[0].finish_reason).toBe('stop');
		expect(body.usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
		expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
	});

	it('streams the turn as SSE and ends it with [DONE]', async () => {
		const url = await start();
		const model = await firstModel(url);

		const response = await post(`${url}/v1/chat/completions`, { ...chat(model), stream: true });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const payloads = payloadsOf(await response.text());
		expect(payloads.at(-1)).toBe('[DONE]');
		const chunks = payloads.slice(0, -1).map(payload => JSON.parse(payload));
		expect(chunks[0].choices[0].delta.role).toBe('assistant');
		expect(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join('')).toBe('hello');
		expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
	});

	it('lists the models of the agent under its id', async () => {
		const url = await start();

		const response = await fetch(`${url}/v1/models`);

		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.object).toBe('list');
		const ids: string[] = body.data.map((entry: { id: string }) => entry.id);
		expect(ids.some(id => id.startsWith('mock/'))).toBe(true);
		for (const entry of body.data as Array<{ object: string; owned_by: string }>) {
			expect(entry.object).toBe('model');
			expect(entry.owned_by).toBe(adapter.id);
		}
	});

	it('answers an unknown model with a 404 in the OpenAI error shape', async () => {
		const url = await start();

		const response = await post(`${url}/v1/chat/completions`, chat('nobody/nothing'));

		expect(response.status).toBe(404);
		const body = await response.json() as any;
		expect(typeof body.error.message).toBe('string');
		expect(body.error.message.length).toBeGreaterThan(0);
		expect(body.error.code).toBe('model_not_found');
	});

	it('answers the health probe with the agents it can drive', async () => {
		const url = await start();

		const response = await fetch(`${url}/health`);

		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.agents).toEqual([expect.objectContaining({ id: adapter.id, installed: true, openSessions: 0 })]);
		expect(body.openSessions).toBe(0);
	});

	it('guards every route but the health probe when a token is configured', async () => {
		const url = await start('secret');

		expect((await fetch(`${url}/health`)).status).toBe(200);
		expect((await fetch(`${url}/v1/models`)).status).toBe(401);
		const guarded = await post(`${url}/v1/chat/completions`, chat('mock/mock-1'));
		expect(guarded.status).toBe(401);
		expect((await guarded.json() as any).error.code).toBe('invalid_api_key');
		expect((await fetch(`${url}/v1/models`, { headers: { Authorization: 'Bearer secret' } })).status).toBe(200);
	});
});
