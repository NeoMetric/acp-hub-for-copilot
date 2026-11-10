/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { Log } from '../../src/engine/ports/host';
import type { StateStore } from '../../src/engine/ports/state';
import type { ModelWire } from '../../src/hosts/http/wire';
import type { LinkState } from '../../src/hosts/vscode/serverLink';
import { modelsStateKey } from '../../src/core/modelInfo';
import { ServerProvider } from '../../src/hosts/vscode/serverProvider';
import { LanguageModelDataPart, LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart } from './vscode-mock';
import { user } from './messages';

const servers: http.Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

/** A loopback server that answers the way the test writes it, and the endpoint that reaches it. */
async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<string> {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** One model as the server publishes it. */
function modelWire(agentId: string, value: string): ModelWire {
	return {
		id: `${agentId}/${value}`,
		object: 'model',
		created: 1_700_000_000,
		owned_by: agentId,
		acp: {
			name: `${value} (${agentId})`,
			family: value,
			version: '1',
			detail: `${agentId} agent`,
			tooltip: value,
			maxInputTokens: 1_000,
			maxOutputTokens: 100,
			toolCalling: true,
			imageInput: true,
			efforts: [],
		},
	};
}

/** One model as the server saves it in the shared store. */
function savedEntry(agentId: string, value: string) {
	return { value, info: modelWire(agentId, value).acp };
}

function modelsReply(models: readonly ModelWire[]): string {
	return JSON.stringify({ object: 'list', data: models });
}

/** A server whose model list and chat replies the test writes. */
function serverWith(models: readonly ModelWire[], chat?: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
	return serve((request, response) => {
		if (request.url === '/v1/models') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(modelsReply(models));
			return;
		}
		if (chat) {
			chat(request, response);
			return;
		}
		response.writeHead(404);
		response.end();
	});
}

class FakeLink {
	ensured = 0;
	/** Whether each `ensure()` was a background one, in the order they were asked. */
	readonly backgrounds: boolean[] = [];
	state: LinkState | undefined;
	private readonly listeners = new Set<(state: LinkState) => void>();

	constructor(private readonly answer: () => Promise<LinkState> | LinkState) { }

	async ensure(options: { readonly background?: boolean } = {}): Promise<LinkState> {
		this.ensured++;
		this.backgrounds.push(options.background === true);
		const next = await this.answer();
		this.publish(next);
		return next;
	}

	onDidChange(listener: (state: LinkState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publish(state: LinkState): void {
		const changed = state.kind !== this.state?.kind;
		this.state = state;
		if (changed) {
			for (const listener of [...this.listeners]) {
				listener(state);
			}
		}
	}
}

class MemoryState implements StateStore {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
	}
}

const ready = (baseUrl: string): LinkState => ({ kind: 'ready', endpoint: { baseUrl }, owned: false });
const unavailable: LinkState = { kind: 'unavailable', reason: 'No server answered on port 8791.' };

/** Resolves with `work`, or fails the test when it takes longer than `ms`. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const bound = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} waited longer than ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([work, bound]);
	} finally {
		clearTimeout(timer);
	}
}

/** Waits until `ready()` holds, or fails the test. */
async function waitUntil(ready: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (ready()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}.`);
}

const logs: string[] = [];
const log: Log = message => { logs.push(message); };

function providerOf(overrides: { agentId?: string; link?: FakeLink; state?: StateStore; windowFolder?: string; log?: Log } = {}): ServerProvider {
	return new ServerProvider({
		agentId: overrides.agentId ?? 'claude',
		vendor: 'Test Agent',
		link: overrides.link ?? new FakeLink(() => unavailable),
		state: overrides.state ?? new MemoryState(),
		log: overrides.log ?? log,
		windowFolder: () => overrides.windowFolder ?? 'c:\\window',
	});
}

const modelsOptions = { silent: false } as unknown as vscode.PrepareLanguageModelChatModelOptions;
const modelInfo = { id: 'sonnet' } as unknown as vscode.LanguageModelChatInformation;
const messages = [user('hi')];
const options = { modelOptions: {}, tools: [], toolMode: 1 } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

function recorded() {
	const parts: unknown[] = [];
	let notify = (): void => { };
	const touched = new Promise<void>(resolve => { notify = resolve; });
	const progress = {
		report(part: unknown) {
			parts.push(part);
			notify();
		},
	} as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;
	return { parts, touched, progress };
}

const token = () => new vscode.CancellationTokenSource().token;

/** One SSE chunk of a reply, as the server writes it: a choice, then its finish, then the figures alone. */
function send(response: http.ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown): void {
	response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
	if (usage) {
		response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
	}
}

/** Ends a reply the way the server does. */
function end(response: http.ServerResponse): void {
	response.write('data: [DONE]\n\n');
	response.end();
}

describe('ServerProvider models', () => {
	it('lists only its own agent\'s models', async () => {
		const baseUrl = await serverWith([modelWire('codex', 'gpt-5'), modelWire('claude', 'sonnet'), modelWire('google', 'gemini')]);
		const state = new MemoryState();
		const provider = providerOf({ link: new FakeLink(() => ready(baseUrl)), state });

		const models = await provider.provideLanguageModelChatInformation(modelsOptions, token());

		expect(models.map(model => model.id)).toEqual(['sonnet', 'sonnet::agent']);
		expect(state.keys()).toEqual([]);
	});

	it('keeps the models the server saved when the server is unavailable, and never writes them', async () => {
		const state = new MemoryState();
		await state.update(modelsStateKey('claude'), [savedEntry('claude', 'sonnet')]);
		const writes = state.keys().length;
		const provider = providerOf({ link: new FakeLink(() => unavailable), state });

		const models = await provider.provideLanguageModelChatInformation(modelsOptions, token());

		expect(models.map(model => model.id)).toEqual(['sonnet', 'sonnet::agent']);
		expect(state.keys().length).toBe(writes);
	});

	it('ignores a saved entry in a shape it cannot show', async () => {
		const state = new MemoryState();
		await state.update(modelsStateKey('claude'), [{ value: 'sonnet' }, 'broken', savedEntry('claude', 'opus')]);
		const provider = providerOf({ link: new FakeLink(() => unavailable), state });

		const models = await provider.provideLanguageModelChatInformation(modelsOptions, token());

		expect(models.map(model => model.id)).toEqual(['opus', 'opus::agent']);
	});

	it('keeps the saved models when the server lists none for its agent', async () => {
		const state = new MemoryState();
		await state.update(modelsStateKey('claude'), [savedEntry('claude', 'sonnet')]);
		const baseUrl = await serverWith([]);
		const provider = providerOf({ link: new FakeLink(() => ready(baseUrl)), state });

		const models = await provider.provideLanguageModelChatInformation(modelsOptions, token());

		expect(models.map(model => model.id)).toEqual(['sonnet', 'sonnet::agent']);
	});

	it('a second provider for another agent does not see the first agent\'s models', async () => {
		const baseUrl = await serverWith([modelWire('claude', 'sonnet'), modelWire('codex', 'gpt-5')]);
		const link = new FakeLink(() => ready(baseUrl));
		const state = new MemoryState();
		const claude = providerOf({ agentId: 'claude', link, state });
		const codex = providerOf({ agentId: 'codex', link, state });

		expect((await claude.provideLanguageModelChatInformation(modelsOptions, token())).map(model => model.id)).toEqual(['sonnet', 'sonnet::agent']);
		expect((await codex.provideLanguageModelChatInformation(modelsOptions, token())).map(model => model.id)).toEqual(['gpt-5', 'gpt-5::agent']);
	});

	it('tells the workbench when the server becomes reachable', async () => {
		const link = new FakeLink(() => unavailable);
		const provider = providerOf({ link });
		let fired = 0;
		provider.onDidChangeLanguageModelChatInformation(() => { fired++; });

		link.publish(ready('http://127.0.0.1:8791'));
		expect(fired).toBe(1);
		link.publish(unavailable);
		expect(fired).toBe(2);
	});

	it('answers from the saved list at once, and reports the live list when it differs', async () => {
		const state = new MemoryState();
		await state.update(modelsStateKey('claude'), [savedEntry('claude', 'sonnet')]);
		const baseUrl = await serverWith([modelWire('claude', 'sonnet'), modelWire('claude', 'opus')]);
		// A cold server: the link is still finding one while the picker asks.
		let release = (): void => { };
		const gate = new Promise<void>(resolve => { release = resolve; });
		const link = new FakeLink(async () => {
			await gate;
			return ready(baseUrl);
		});
		const provider = providerOf({ link, state });
		let fired = 0;
		provider.onDidChangeLanguageModelChatInformation(() => { fired++; });

		const models = await within(provider.provideLanguageModelChatInformation(modelsOptions, token()), 500, 'the picker');
		expect(models.map(model => model.id)).toEqual(['sonnet', 'sonnet::agent']);

		release();
		await waitUntil(() => fired > 0, 'the live list to be reported');
		// The server coming up reports a change of its own before the list arrives, so wait for the list itself.
		let live: string[] = [];
		await waitUntil(() => {
			void provider.provideLanguageModelChatInformation(modelsOptions, token()).then(offered => { live = offered.map(model => model.id); });
			return live.length === 4;
		}, 'the live list to be offered');
		expect(live).toEqual(['sonnet', 'sonnet::agent', 'opus', 'opus::agent']);
		expect(state.get(modelsStateKey('claude'))).toEqual([savedEntry('claude', 'sonnet')]);
	});

	it('does not report a change again once the live list is the one it offers', async () => {
		const state = new MemoryState();
		await state.update(modelsStateKey('claude'), [savedEntry('claude', 'sonnet')]);
		const live = modelWire('claude', 'sonnet');
		live.acp!.name = 'Renamed';
		const baseUrl = await serverWith([live]);
		const link = new FakeLink(() => ready(baseUrl));
		// Already ready, so the only change reported is the list's own.
		link.publish(ready(baseUrl));
		const provider = providerOf({ link, state });
		let fired = 0;
		provider.onDidChangeLanguageModelChatInformation(() => { fired++; });

		await provider.provideLanguageModelChatInformation(modelsOptions, token());
		await waitUntil(() => fired === 1, 'the rename to be reported');
		await provider.provideLanguageModelChatInformation(modelsOptions, token());
		await new Promise(resolve => setTimeout(resolve, 100));

		expect(fired).toBe(1);
	});

	it('lists again after a refresh, so an agent that changed is not stuck', async () => {
		const baseUrl = await serverWith([modelWire('claude', 'sonnet')]);
		const link = new FakeLink(() => ready(baseUrl));
		const state = new MemoryState();
		const provider = providerOf({ link, state });
		await provider.provideLanguageModelChatInformation(modelsOptions, token());
		const listed = link.ensured;

		provider.refresh();
		await provider.provideLanguageModelChatInformation(modelsOptions, token());

		await waitUntil(() => link.ensured > listed, 'the models to be listed again');
	});

	it('refresh asks the workbench to list the models again', () => {
		const provider = providerOf();
		let fired = 0;
		provider.onDidChangeLanguageModelChatInformation(() => { fired++; });

		provider.refresh();

		expect(fired).toBe(1);
	});
});

describe('ServerProvider chat', () => {
	it('streams text, thinking, tool calls and usage in order', async () => {
		let body: { model?: string; acp?: { cwd?: string } } = {};
		const baseUrl = await serverWith([], (request, response) => {
			let text = '';
			request.on('data', chunk => { text += String(chunk); });
			request.on('end', () => {
				body = JSON.parse(text) as typeof body;
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				send(response, { reasoning_content: 'weighing it' });
				send(response, { content: 'the answer' });
				send(response, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] });
				send(response, {}, 'tool_calls', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } });
				end(response);
			});
		});
		const provider = providerOf({ link: new FakeLink(() => ready(baseUrl)), windowFolder: 'c:\\window' });
		const { parts, progress } = recorded();

		await provider.provideLanguageModelChatResponse({ id: 'sonnet::agent' } as vscode.LanguageModelChatInformation, messages, options, progress, token());

		expect(parts[0]).toBeInstanceOf(LanguageModelThinkingPart);
		expect((parts[0] as LanguageModelThinkingPart).value).toBe('weighing it');
		expect(parts[1]).toBeInstanceOf(LanguageModelTextPart);
		expect(parts[1]).toMatchObject({ value: 'the answer' });
		expect(parts[2]).toBeInstanceOf(LanguageModelToolCallPart);
		expect(parts[2]).toMatchObject({ callId: 'call_1', name: 'read_file', input: { path: 'a.ts' } });
		expect(parts[3]).toBeInstanceOf(LanguageModelDataPart);
		const usage = parts[3] as LanguageModelDataPart;
		expect(usage.mimeType).toBe('usage');
		expect(JSON.parse(new TextDecoder().decode(usage.data))).toEqual({
			prompt_tokens: 12,
			completion_tokens: 3,
			total_tokens: 15,
			prompt_tokens_details: { cached_tokens: 4 },
			completion_tokens_details: { reasoning_tokens: 2 },
		});
		// The picker's id is bare; the body names the agent beside it, never twice.
		expect(body.model).toBe('claude/sonnet');
		expect(body.acp?.cwd).toBe('c:\\window');
	});

	it('fills a missing detail of the usage with zero', async () => {
		const baseUrl = await serverWith([], (_request, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			send(response, { content: 'ok' });
			send(response, {}, 'stop', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
			end(response);
		});
		const provider = providerOf({ link: new FakeLink(() => ready(baseUrl)) });
		const { parts, progress } = recorded();

		await provider.provideLanguageModelChatResponse(modelInfo, messages, options, progress, token());

		const usage = parts.find(part => part instanceof LanguageModelDataPart) as LanguageModelDataPart;
		expect(JSON.parse(new TextDecoder().decode(usage.data))).toMatchObject({
			prompt_tokens_details: { cached_tokens: 0 },
			completion_tokens_details: { reasoning_tokens: 0 },
		});
	});

	it('turns the error chunk of a failed turn into a LanguageModelError with its words', async () => {
		const baseUrl = await serverWith([], (_request, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ error: { message: 'The agent stopped.', type: 'server_error', code: 'engine_error', param: null } })}\n\n`);
			response.write('data: [DONE]\n\n');
			response.end();
		});
		const provider = providerOf({ link: new FakeLink(() => ready(baseUrl)) });

		const error = await provider
			.provideLanguageModelChatResponse(modelInfo, messages, options, recorded().progress, token())
			.then(() => undefined, (failure: unknown) => failure);

		expect(error).toBeInstanceOf(vscode.LanguageModelError);
		expect((error as Error).message).toBe('The agent stopped.');
	});

	it('cancellation aborts the request', async () => {
		let closed = (): void => { };
		const hangUp = new Promise<void>(resolve => { closed = resolve; });
		const baseUrl = await serverWith([], (_request, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			send(response, { content: 'first' });
			// The reply is never finished: the window leaves the turn instead.
			response.on('close', () => closed());
		});
		const provider = providerOf({ link: new FakeLink(() => ready(baseUrl)) });
		const { touched, progress } = recorded();
		const source = new vscode.CancellationTokenSource();

		const pending = provider.provideLanguageModelChatResponse(modelInfo, messages, options, progress, source.token);
		await touched;
		source.cancel();

		await expect(pending).resolves.toBeUndefined();
		await hangUp;
	});

	it('a dropped connection throws LanguageModelError and triggers ensure()', async () => {
		const baseUrl = await serverWith([], (request, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			send(response, { content: 'half an ans' });
			// The server dies mid-turn.
			setTimeout(() => request.socket.destroy(), 10);
		});
		const link = new FakeLink(() => ready(baseUrl));
		const provider = providerOf({ link });
		const before = link.ensured;

		const error = await provider
			.provideLanguageModelChatResponse(modelInfo, messages, options, recorded().progress, token())
			.then(() => undefined, (failure: unknown) => failure);

		expect(error).toBeInstanceOf(vscode.LanguageModelError);
		expect((error as Error).message).toContain('127.0.0.1');
		// One ensure() opened the turn; the failure asked for another, so the next message has a server.
		expect(link.ensured).toBe(before + 2);
		// The turn's own check asked for the server; the one after a failure must not undo a stop the user asked for.
		expect(link.backgrounds).toEqual([false, true]);
	});

	it('an unavailable server throws LanguageModelError naming the reason', async () => {
		const provider = providerOf({ link: new FakeLink(() => unavailable) });

		const error = await provider
			.provideLanguageModelChatResponse(modelInfo, messages, options, recorded().progress, token())
			.then(() => undefined, (failure: unknown) => failure);

		expect(error).toBeInstanceOf(vscode.LanguageModelError);
		expect((error as Error).message).toContain('8791');
	});

	it('counts a quarter of the characters as tokens', async () => {
		const provider = providerOf();

		expect(await provider.provideTokenCount(modelInfo, 'twelve chars', token())).toBe(3);
	});

	it('tells when a chat was asked for, and how long each step before the first event took', async () => {
		const baseUrl = await serverWith([], (_request, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			send(response, { content: 'ok' });
			send(response, {}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
			end(response);
		});
		const lines: Array<{ message: string; level: string | undefined }> = [];
		const provider = providerOf({ link: new FakeLink(() => ready(baseUrl)), log: (message, level) => { lines.push({ message, level }); } });

		await provider.provideLanguageModelChatResponse(modelInfo, messages, options, recorded().progress, token());

		expect(lines[0]).toEqual({ message: 'Chat request from Copilot for sonnet: 1 message(s)', level: 'info' });
		expect(lines.slice(1).map(line => line.level)).toEqual(['debug', 'debug']);
		expect(lines[1].message).toMatch(/^Reaching the server took \d+ ms and building the request \d+ ms\.$/);
		expect(lines[2].message).toMatch(/^The first event of the turn arrived after \d+ ms\.$/);
	});
});
