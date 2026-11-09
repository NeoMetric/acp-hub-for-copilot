/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { HeadlessComposition } from '../../composition/headless';
import { AdapterNotInstalledError } from '../../engine/acp/agentClient';
import type { AcpConfigOption, AgentSession } from '../../engine/acp/protocol';
import type { ChatService } from '../../engine/chat/ChatService';
import { ChatError } from '../../engine/chat/ChatError';
import type { ChatMessage, ChatRequest, ChatRole, Part, ToolDef } from '../../engine/model/chat';
import type { StreamEvent } from '../../engine/model/stream';
import { rememberHeaders } from './host';

/** The most a completion body may hold; a bigger one is refused rather than read into memory. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The model id that names whatever the agent has selected. A chat-completions
 * client always sends a model, and an agent whose models could not be read
 * still has to be reachable.
 */
const AGENT_DEFAULT_MODEL = 'default';

/** The finish reasons OpenAI clients understand. */
type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

/** One tool call a turn asked for, as the client receives it. */
interface TurnToolCall {
	readonly callId: string;
	readonly name: string;
	readonly input: unknown;
}

interface TurnUsage {
	readonly promptTokens: number;
	readonly cachedTokens: number;
	readonly outputTokens: number;
}

/** What the events of one turn said, gathered so the response can be written in one piece. */
interface TurnResult {
	text: string;
	toolCalls: TurnToolCall[];
	usage?: TurnUsage;
	stopReason?: string;
	error?: string;
}

export interface HttpServerOptions {
	/** The process's wiring: the host, the agents and their chat use cases. */
	readonly composition: HeadlessComposition;
	/** When set, every route but `GET /health` requires `Authorization: Bearer <token>`. */
	readonly token?: string;
}

/**
 * The engine behind an OpenAI-compatible surface: chat completions over SSE or
 * one JSON body, the model list, and a health probe. The host runs the tools
 * the agent calls, so the endpoint only returns `tool_calls`.
 */
export function createServer(options: HttpServerOptions): http.Server {
	const { composition, token } = options;
	return http.createServer((request, response) => {
		void handle(composition, token, request, response);
	});
}

async function handle(composition: HeadlessComposition, token: string | undefined, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
	try {
		const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
		// The health probe is what a process manager reads, before it has any token.
		if (pathname === '/health' && request.method === 'GET') {
			await sendHealth(composition, response);
			return;
		}
		if (token !== undefined && !carriesToken(request, token)) {
			response.setHeader('WWW-Authenticate', 'Bearer');
			sendError(response, 401, 'A bearer token is required; send it as "Authorization: Bearer <token>".', 'invalid_request_error', 'invalid_api_key');
			return;
		}
		if (pathname === '/v1/models' && request.method === 'GET') {
			await sendModels(composition, response);
			return;
		}
		if (pathname === '/v1/chat/completions' && request.method === 'POST') {
			await complete(composition, request, response);
			return;
		}
		sendError(response, 404, `No route for ${request.method ?? 'GET'} ${pathname}.`, 'invalid_request_error', 'not_found');
	} catch (error) {
		composition.host.log(`An HTTP request failed: ${messageOf(error)}`, 'error');
		sendError(response, 500, messageOf(error), 'server_error', 'internal_error');
	}
}

/** `GET /health`: the agents, whether each is installed, and how many chat sessions are open. */
async function sendHealth(composition: HeadlessComposition, response: http.ServerResponse): Promise<void> {
	const agents: Array<{ id: string; installed: boolean; openSessions: number }> = [];
	let openSessions = 0;
	for (const adapter of composition.adapters) {
		const service = composition.serviceOf(adapter.id);
		const sessions = service?.openSessions ?? 0;
		openSessions += sessions;
		agents.push({ id: adapter.id, installed: service !== undefined && await isInstalled(service, composition), openSessions: sessions });
	}
	sendJson(response, 200, { status: 'ok', openSessions, agents });
}

/** `GET /v1/models`: one entry per agent and model, so two agents' models cannot collide. */
async function sendModels(composition: HeadlessComposition, response: http.ServerResponse): Promise<void> {
	const data: Array<{ id: string; object: 'model'; owned_by: string }> = [];
	for (const adapter of composition.adapters) {
		const service = composition.serviceOf(adapter.id);
		if (!service || !await isInstalled(service, composition)) {
			continue;
		}
		const modelIds = await modelIdsOf(service, composition);
		for (const modelId of modelIds.length > 0 ? modelIds : [AGENT_DEFAULT_MODEL]) {
			data.push({ id: `${adapter.id}/${modelId}`, object: 'model', owned_by: adapter.id });
		}
	}
	sendJson(response, 200, { object: 'list', data });
}

/** The model values the agent's own session reported, or none when it offers no model option. */
async function modelIdsOf(service: ChatService, composition: HeadlessComposition): Promise<string[]> {
	try {
		const session = await service.openWarmSession();
		const option = modelOptionOf(session);
		return option ? valuesOf(option) : [];
	} catch (error) {
		composition.host.log(`Could not read the models of ${service.adapter.id}: ${messageOf(error)}`, 'warn');
		return [];
	}
}

function modelOptionOf(session: AgentSession): AcpConfigOption | undefined {
	const isSelect = (option: AcpConfigOption): boolean => option.type === 'select';
	return session.configOptions.find(option => option.category === 'model' && isSelect(option))
		?? session.configOptions.find(option => option.id === 'model' && isSelect(option));
}

function valuesOf(option: AcpConfigOption): string[] {
	const values: string[] = [];
	for (const entry of option.options ?? []) {
		if ('group' in entry) {
			values.push(...entry.options.map(choice => choice.value));
		} else {
			values.push(entry.value);
		}
	}
	return values;
}

/** Whether the agent is on this machine; asking for its client reads no more than the install and the settings. */
async function isInstalled(service: ChatService, composition: HeadlessComposition): Promise<boolean> {
	try {
		await service.client();
		return true;
	} catch (error) {
		if (!(error instanceof AdapterNotInstalledError)) {
			composition.host.log(`Could not open the ${service.adapter.id} agent: ${messageOf(error)}`, 'warn');
		}
		return false;
	}
}

/** `POST /v1/chat/completions`, streaming or not, over the agent the model id names. */
async function complete(composition: HeadlessComposition, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
	let body: Record<string, unknown>;
	try {
		body = await readBody(request);
	} catch (error) {
		sendError(response, 400, messageOf(error), 'invalid_request_error', 'invalid_body');
		return;
	}
	const model = typeof body.model === 'string' ? body.model.trim() : '';
	const target = splitModelId(model);
	if (!target) {
		sendError(response, 404, `Unknown model "${model}"; a model id looks like "<agentId>/<modelId>".`, 'invalid_request_error', 'model_not_found');
		return;
	}
	const service = composition.serviceOf(target.agentId);
	if (!service) {
		sendError(response, 404, `Unknown agent "${target.agentId}" in model "${model}".`, 'invalid_request_error', 'model_not_found');
		return;
	}
	if (!await isInstalled(service, composition)) {
		sendError(response, 404, `The agent of model "${model}" is not installed; install it from the ACP Hub sidebar.`, 'invalid_request_error', 'model_not_found');
		return;
	}
	const messages = messagesOf(body.messages);
	// A turn the client continues after a tool call may arrive without its user
	// message again; anything else has to say something to the agent.
	const continuesATurn = messages.some(message => message.role === 'user' || message.parts.some(part => part.type === 'tool-result'));
	if (!continuesATurn) {
		sendError(response, 400, 'The request has no user message.', 'invalid_request_error', 'invalid_messages');
		return;
	}
	const chatRequest = chatRequestOf(composition, request, messages, toolsOf(body), target.model);
	if (body.stream === true) {
		await stream(service, chatRequest, model, response);
		return;
	}
	await collect(service, chatRequest, model, response);
}

/** Builds the engine's request, naming the chat the way the host does when the client names none. */
function chatRequestOf(composition: HeadlessComposition, request: http.IncomingMessage, messages: readonly ChatMessage[], tools: readonly ToolDef[], model: string): ChatRequest {
	const headers = { chatId: headerOf(request, 'x-chat-id'), cwd: headerOf(request, 'x-acp-cwd') };
	const draft: ChatRequest = { chatId: '', cwd: '', messages, tools, model: model === AGENT_DEFAULT_MODEL ? undefined : model };
	rememberHeaders(draft, headers);
	// A stock OpenAI client sends no chat id, so the host names the chat by its
	// folder and its opening words; the engine must then be given that name.
	const identity = composition.host.chatIdentity(draft);
	return { chatId: identity.id, cwd: identity.cwd, messages, tools, model: draft.model };
}

/** One JSON body: the turn is followed to its end, or to the tool calls the client has to run. */
async function collect(service: ChatService, request: ChatRequest, model: string, response: http.ServerResponse): Promise<void> {
	const turn = emptyTurn();
	const controller = new AbortController();
	const disconnected = (): void => controller.abort();
	response.on('close', disconnected);
	try {
		await service.respond(request, event => gather(turn, event), controller.signal);
	} catch (error) {
		sendFailure(response, error);
		return;
	} finally {
		// A client that stays connected while the turn parks on a tool call is not
		// a disconnect: the next request continues that turn.
		response.off('close', disconnected);
	}
	sendJson(response, 200, completionOf(turn, model));
}

/** SSE: a role chunk, the deltas of the turn, a chunk that ends the choice, and `[DONE]`. */
async function stream(service: ChatService, request: ChatRequest, model: string, response: http.ServerResponse): Promise<void> {
	response.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});
	const id = `chatcmpl-${randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const write = (chunk: unknown): void => {
		if (!response.writableEnded && !response.destroyed) {
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
	};
	write(chunkOf(id, created, model, { role: 'assistant' }, null));
	const turn = emptyTurn();
	const controller = new AbortController();
	const disconnected = (): void => controller.abort();
	response.on('close', disconnected);
	try {
		await service.respond(request, event => {
			gather(turn, event);
			if (event.type === 'text') {
				write(chunkOf(id, created, model, { content: event.text }, null));
			} else if (event.type === 'tool-call') {
				write(chunkOf(id, created, model, { tool_calls: [toolCallDelta(turn.toolCalls.length - 1, event)] }, null));
			}
		}, controller.signal);
	} catch (error) {
		write({ error: { message: messageOf(error), type: 'server_error', code: 'engine_error' } });
	} finally {
		response.off('close', disconnected);
	}
	write(chunkOf(id, created, model, {}, finishOf(turn), turn.usage ? usageOf(turn.usage) : undefined));
	if (!response.writableEnded && !response.destroyed) {
		response.write('data: [DONE]\n\n');
		response.end();
	}
}

function emptyTurn(): TurnResult {
	return { text: '', toolCalls: [] };
}

/** Keeps what one event of the turn said, for the body written once the turn is done. */
function gather(turn: TurnResult, event: StreamEvent): void {
	switch (event.type) {
		case 'text':
			turn.text += event.text;
			return;
		case 'tool-call':
			turn.toolCalls.push({ callId: event.callId, name: event.name, input: event.input });
			return;
		case 'usage':
			turn.usage = { promptTokens: event.promptTokens, cachedTokens: event.cachedTokens, outputTokens: event.outputTokens };
			return;
		case 'done':
			turn.stopReason = event.stopReason;
			return;
		case 'error':
			turn.error = event.message;
			return;
		case 'thought':
			return;
	}
}

function finishOf(turn: TurnResult): FinishReason {
	if (turn.error !== undefined) {
		return 'error';
	}
	// A turn that parked on a tool call ends its response without a stop reason.
	if (turn.stopReason === undefined) {
		return turn.toolCalls.length > 0 ? 'tool_calls' : 'stop';
	}
	return turn.stopReason === 'max_tokens' ? 'length' : 'stop';
}

function completionOf(turn: TurnResult, model: string): unknown {
	const message: Record<string, unknown> = { role: 'assistant', content: turn.text.length > 0 ? turn.text : null };
	if (turn.toolCalls.length > 0) {
		message.tool_calls = turn.toolCalls.map(call => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: argumentsOf(call.input) } }));
	}
	return {
		id: `chatcmpl-${randomUUID()}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: finishOf(turn) }],
		...(turn.usage ? { usage: usageOf(turn.usage) } : {}),
	};
}

function chunkOf(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: FinishReason | null, usage?: unknown): unknown {
	return {
		id,
		object: 'chat.completion.chunk',
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	};
}

function toolCallDelta(index: number, event: Extract<StreamEvent, { type: 'tool-call' }>): unknown {
	return { index, id: event.callId, type: 'function', function: { name: event.name, arguments: argumentsOf(event.input) } };
}

function argumentsOf(input: unknown): string {
	if (typeof input === 'string') {
		return input;
	}
	return JSON.stringify(input ?? {});
}

function usageOf(usage: TurnUsage): unknown {
	return {
		prompt_tokens: usage.promptTokens,
		completion_tokens: usage.outputTokens,
		total_tokens: usage.promptTokens + usage.outputTokens,
		...(usage.cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } } : {}),
	};
}

/** The messages of the body as the engine's own: text, tool calls, and the results the client ran. */
function messagesOf(value: unknown): ChatMessage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const messages: ChatMessage[] = [];
	for (const entry of value) {
		if (!isObject(entry)) {
			continue;
		}
		const role = roleOf(entry.role);
		if (!role) {
			continue;
		}
		const parts = partsOf(entry, role);
		if (parts.length === 0) {
			continue;
		}
		const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined;
		messages.push({ role, parts, ...(name ? { name } : {}) });
	}
	return messages;
}

function roleOf(value: unknown): ChatRole | undefined {
	// `developer` is OpenAI's newer name for the system message.
	return value === 'system' || value === 'developer' ? 'system'
		: value === 'user' || value === 'assistant' || value === 'tool' ? value
			: undefined;
}

function partsOf(message: Record<string, unknown>, role: ChatRole): Part[] {
	const parts: Part[] = [];
	if (typeof message.content === 'string') {
		if (message.content.length > 0) {
			parts.push({ type: 'text', text: message.content });
		}
	} else if (Array.isArray(message.content)) {
		for (const item of message.content) {
			if (isObject(item) && item.type === 'text' && typeof item.text === 'string') {
				parts.push({ type: 'text', text: item.text });
			}
		}
	}
	if (role === 'assistant' && Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (!isObject(call) || typeof call.id !== 'string' || !isObject(call.function) || typeof call.function.name !== 'string') {
				continue;
			}
			parts.push({ type: 'tool-call', callId: call.id, name: call.function.name, input: call.function.arguments === undefined ? {} : parseArguments(call.function.arguments) });
		}
	}
	if (role === 'tool') {
		parts.push({ type: 'tool-result', callId: typeof message.tool_call_id === 'string' ? message.tool_call_id : '', content: [{ type: 'text', text: contentTextOf(message.content) }] });
	}
	return parts;
}

function contentTextOf(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	return value.map(item => isObject(item) && typeof item.text === 'string' ? item.text : '').join('\n');
}

function parseArguments(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch {
		// An agent may have answered with text that is not JSON; the call still carries it.
		return value;
	}
}

/** The tools the body offers, narrowed to the one `tool_choice` names and emptied by `none`. */
function toolsOf(body: Record<string, unknown>): ToolDef[] {
	const declared: ToolDef[] = [];
	if (Array.isArray(body.tools)) {
		for (const entry of body.tools) {
			if (!isObject(entry) || !isObject(entry.function)) {
				continue;
			}
			const fn = entry.function;
			if (typeof fn.name !== 'string' || fn.name.length === 0) {
				continue;
			}
			declared.push({
				name: fn.name,
				description: typeof fn.description === 'string' ? fn.description : '',
				inputSchema: fn.parameters ?? { type: 'object', properties: {} },
			});
		}
	}
	const choice = body.tool_choice;
	if (choice === 'none') {
		return [];
	}
	if (isObject(choice) && isObject(choice.function) && typeof choice.function.name === 'string') {
		const chosen = choice.function.name;
		return declared.filter(tool => tool.name === chosen);
	}
	return declared;
}

function splitModelId(model: string): { agentId: string; model: string } | undefined {
	const at = model.indexOf('/');
	if (at <= 0 || at === model.length - 1) {
		return undefined;
	}
	return { agentId: model.slice(0, at), model: model.slice(at + 1) };
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			throw new Error(`The request body is larger than ${MAX_BODY_BYTES} bytes.`);
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if (text.trim().length === 0) {
		throw new Error('The request body is empty.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('The request body is not valid JSON.');
	}
	if (!isObject(parsed)) {
		throw new Error('The request body is not a JSON object.');
	}
	return parsed;
}

function headerOf(request: http.IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	const text = (Array.isArray(value) ? value[0] : value)?.trim();
	return text ? text : undefined;
}

function carriesToken(request: http.IncomingMessage, token: string): boolean {
	const header = headerOf(request, 'authorization');
	if (!header) {
		return false;
	}
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendFailure(response: http.ServerResponse, error: unknown): void {
	if (error instanceof AdapterNotInstalledError) {
		sendError(response, 404, error.message, 'invalid_request_error', 'model_not_found');
		return;
	}
	if (error instanceof ChatError) {
		sendError(response, 400, error.message, 'invalid_request_error', 'chat_error');
		return;
	}
	sendError(response, 500, messageOf(error), 'server_error', 'engine_error');
}

/** The error shape OpenAI clients read: `{ error: { message, type, code } }`. */
function sendError(response: http.ServerResponse, status: number, message: string, type: string, code: string | null): void {
	if (response.headersSent) {
		if (!response.writableEnded) {
			response.end();
		}
		return;
	}
	sendJson(response, status, { error: { message, type, code } });
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
	response.end(body);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
