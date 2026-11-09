/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelWire } from '../http/wire';
import type { ServerEndpoint } from './serverLink';

/**
 * The window's HTTP client for the server's chat surface. It holds no engine
 * and no editor API: it lists the models the server publishes and reads the
 * stream of one turn, so the provider above it only has to turn events into
 * what Copilot renders.
 */

const MODELS_ROUTE = '/v1/models';
const CHAT_ROUTE = '/v1/chat/completions';

/** One thing a turn said, as the provider above reports it. */
export type WireEvent =
	| { type: 'text'; text: string }
	| { type: 'thought'; text: string }
	| { type: 'tool-call'; callId: string; name: string; input: unknown }
	| { type: 'usage'; usage: WireUsage }
	| { type: 'error'; message: string };

/** The figures of a turn, in the shape the chat already reports them in. */
export interface WireUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}

/** A turn the server could not be talked through, in words the chat can show. */
export class ServerChatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ServerChatError';
	}
}

/** The models the server publishes, with whatever picker metadata it added. */
export async function listModels(endpoint: ServerEndpoint, signal?: AbortSignal): Promise<ModelWire[]> {
	const response = await send(endpoint, MODELS_ROUTE, { method: 'GET', signal }, 'the model list');
	let value: unknown;
	try {
		value = JSON.parse(await response.text());
	} catch {
		throw new ServerChatError(`The server at ${endpoint.baseUrl} answered the model list with something that is not JSON.`);
	}
	return modelsOf(value);
}

/**
 * Sends one chat request and reports what the reply streams. Tool calls are
 * assembled from their deltas by index, since their arguments arrive in pieces.
 * A signal that fires ends the read without an error: the window left the turn.
 */
export async function streamChat(endpoint: ServerEndpoint, body: unknown, signal: AbortSignal, onEvent: (event: WireEvent) => void): Promise<void> {
	let response: Response;
	try {
		response = await send(endpoint, CHAT_ROUTE, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
			signal,
		}, 'the chat request');
	} catch (error) {
		if (signal.aborted) {
			return;
		}
		throw error;
	}

	const stream = response.body;
	if (!stream) {
		throw unreadable(endpoint, undefined);
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const pending = new Map<number, { id: string; name: string; arguments: string }>();
	let buffer = '';
	let done = false;
	let finished = false;

	/** Reports the calls whose deltas are all in, in the order the model made them. */
	const reportCalls = (): void => {
		for (const index of [...pending.keys()].sort((left, right) => left - right)) {
			const call = pending.get(index);
			pending.delete(index);
			if (call) {
				onEvent({ type: 'tool-call', callId: call.id, name: call.name, input: argumentsOf(call.arguments) });
			}
		}
	};

	/** Reads one `data:` payload; `true` when it ended the stream. */
	const read = (payload: string): boolean => {
		if (payload === '[DONE]') {
			return true;
		}
		const value = parseJson(payload);
		if (!isObject(value)) {
			return false;
		}
		const error = isObject(value.error) ? textOf(value.error.message) : undefined;
		if (error !== undefined && error.length > 0) {
			onEvent({ type: 'error', message: error });
		}
		const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
		const delta = isObject(choice) && isObject(choice.delta) ? choice.delta : {};
		if (typeof delta.content === 'string' && delta.content.length > 0) {
			onEvent({ type: 'text', text: delta.content });
		}
		if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
			onEvent({ type: 'thought', text: delta.reasoning_content });
		}
		if (Array.isArray(delta.tool_calls)) {
			mergeCalls(pending, delta.tool_calls);
		}
		if (isObject(choice) && typeof choice.finish_reason === 'string') {
			finished = true;
			reportCalls();
		}
		const usage = usageOf(value.usage);
		if (usage) {
			onEvent({ type: 'usage', usage });
		}
		return false;
	};

	try {
		reading: for (;;) {
			const { value, done: ended } = await reader.read();
			if (ended) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const at = buffer.indexOf('\n');
				if (at < 0) {
					break;
				}
				const line = buffer.slice(0, at).replace(/\r$/, '');
				buffer = buffer.slice(at + 1);
				if (!line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice('data:'.length).trim();
				if (payload.length === 0) {
					continue;
				}
				if (read(payload)) {
					done = true;
					break reading;
				}
			}
		}
	} catch (error) {
		if (signal.aborted) {
			return;
		}
		throw unreadable(endpoint, error);
	} finally {
		await release(reader);
	}

	if (!done && !finished) {
		throw unreadable(endpoint, undefined);
	}
	reportCalls();
}

function modelsOf(value: unknown): ModelWire[] {
	if (!isObject(value) || !Array.isArray(value.data)) {
		return [];
	}
	const models: ModelWire[] = [];
	for (const entry of value.data) {
		if (isObject(entry) && typeof entry.id === 'string' && entry.id.length > 0) {
			models.push(entry as unknown as ModelWire);
		}
	}
	return models;
}

/** One request to the server, answered or refused in words the chat can show. */
async function send(endpoint: ServerEndpoint, route: string, init: RequestInit, what: string): Promise<Response> {
	const headers: Record<string, string> = { accept: 'application/json, text/event-stream', ...(init.headers as Record<string, string> | undefined) };
	if (endpoint.token !== undefined) {
		headers.authorization = `Bearer ${endpoint.token}`;
	}
	let response: Response;
	try {
		response = await fetch(`${endpoint.baseUrl}${route}`, { ...init, headers });
	} catch (error) {
		throw new ServerChatError(`Could not reach the server at ${endpoint.baseUrl}: ${messageOf(error)}`);
	}
	if (!response.ok) {
		throw await refusalOf(endpoint, response, what);
	}
	return response;
}

/** What a server that said no answered, in one readable sentence. */
async function refusalOf(endpoint: ServerEndpoint, response: Response, what: string): Promise<ServerChatError> {
	const detail = await detailOf(response);
	const answer = `${what}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${detail ? ` — ${detail}` : ''}`;
	// Never the token itself: it is the one thing that must not reach a log or a chat.
	const hint = response.status !== 401 && response.status !== 403 ? ''
		: endpoint.token === undefined
			? ' The request carried no bearer token, so the server refused it.'
			: ' The bearer token was refused; the token file the server was started with may be stale, so restart the server.';
	return new ServerChatError(`The server at ${endpoint.baseUrl} refused ${answer}.${hint}`);
}

/** The server's own words for a refusal, from its error body when it wrote one. */
async function detailOf(response: Response): Promise<string> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return '';
	}
	const value = parseJson(text);
	const message = isObject(value) && isObject(value.error) ? textOf(value.error.message) : undefined;
	return (message ?? text).trim().slice(0, 300);
}

function unreadable(endpoint: ServerEndpoint, error: unknown): ServerChatError {
	const reason = error === undefined ? '' : ` (${messageOf(error)})`;
	return new ServerChatError(`The server at ${endpoint.baseUrl} ended the reply before it finished${reason}.`);
}

async function release(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	try {
		await reader.cancel();
	} catch {
		// The reply is already gone; there is nothing left to release.
	}
}

/** Keeps the pieces of each call under the index the deltas name. */
function mergeCalls(pending: Map<number, { id: string; name: string; arguments: string }>, deltas: readonly unknown[]): void {
	deltas.forEach((value, position) => {
		if (!isObject(value)) {
			return;
		}
		const index = typeof value.index === 'number' ? value.index : position;
		const call = pending.get(index) ?? { id: '', name: '', arguments: '' };
		const fn = isObject(value.function) ? value.function : {};
		if (typeof value.id === 'string' && value.id.length > 0) {
			call.id = value.id;
		}
		if (typeof fn.name === 'string' && fn.name.length > 0) {
			call.name = fn.name;
		}
		if (typeof fn.arguments === 'string') {
			call.arguments += fn.arguments;
		}
		pending.set(index, call);
	});
}

/** The arguments of a call, which an agent may have written as text that is not JSON. */
function argumentsOf(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return {};
	}
	const parsed = parseJson(trimmed);
	return parsed === undefined ? value : parsed;
}

function usageOf(value: unknown): WireUsage | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const prompt = numberOr(value.prompt_tokens);
	const completion = numberOr(value.completion_tokens);
	const details = isObject(value.prompt_tokens_details) ? { prompt_tokens_details: value.prompt_tokens_details } : {};
	const completionDetails = isObject(value.completion_tokens_details) ? { completion_tokens_details: value.completion_tokens_details } : {};
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: numberOr(value.total_tokens) || prompt + completion,
		...details,
		...completionDetails,
	} as WireUsage;
}

function numberOr(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function textOf(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
