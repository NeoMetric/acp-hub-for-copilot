/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { HeadlessComposition } from '../../composition/headless';
import { AdapterNotInstalledError } from '../../engine/acp/agentClient';
import type { AcpConfigOption, AgentSession } from '../../engine/acp/protocol';
import type { ChatService } from '../../engine/chat/ChatService';
import { ChatError } from '../../engine/chat/ChatError';
import type { ControlSurface } from '../../engine/control/ControlService';
import type { ChatMessage, ChatRequest, ChatRole, Part, ToolDef } from '../../engine/model/chat';
import type { StreamEvent } from '../../engine/model/stream';
import type { Log } from '../../engine/ports/host';
import { ControlPage } from '../../ui/controlPage';
import type { ControlAction, ControlState } from '../../ui/messages';
import { ACTION_ROUTE, EVENTS_ROUTE, STATE_ROUTE } from '../../ui/transport';
import { DEFAULT_TOOL_CALL_WAIT_MS, rememberHeaders, ToolCallParking } from './host';
import { API_VERSION, SERVER_NAME, type HealthWire } from './wire';

/** The package version esbuild bakes into the bundle; it is undefined when the sources run unbundled. */
declare const __ACP_HUB_VERSION__: string | undefined;

/** The version `/health` names: the package's own, or 'dev' for a build that was never made. */
const VERSION = typeof __ACP_HUB_VERSION__ === 'undefined' ? 'dev' : __ACP_HUB_VERSION__;

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
	/** How long a client may take to return a tool call's result; {@link DEFAULT_TOOL_CALL_WAIT_MS} otherwise. */
	readonly toolCallWaitMs?: number;
	/** The control page; without it the server offers the chat surface alone. */
	readonly page?: ControlPageOptions;
}

/** Where the page's files are, and what it may ask this host to do. */
export interface ControlPageOptions {
	/** The operations the page drives: the same surface the VS Code sidebar drives. */
	readonly control: ControlSurface;
	/** Opens a URL the page shows as a link; the server logs it by default. */
	readonly openExternal?: (url: string) => Promise<void>;
	/** Copies text for the page; a server has no clipboard, so it logs it by default. */
	readonly copyToClipboard?: (text: string) => Promise<void>;
	/** The built page bundle; `dist/sidebar.js` beside `server-dist/` by default. */
	readonly bundle?: string;
	/** The page's stylesheet; `media/sidebar.css` next to the bundles by default. */
	readonly style?: string;
}

/** The page as the server runs it: the operations, and the two files it is made of. */
interface OpenPage {
	readonly control: ControlPage;
	readonly bundle: string;
	readonly style: string;
}

/**
 * The page's files: the bundle `server-dist/` sits beside in `dist/`, and the
 * stylesheet in `media/`. A source checkout resolves them from the working
 * folder, which is where both builds put them too.
 */
function pageBundlePath(): string {
	return firstExisting([
		path.join(__dirname, '..', 'dist', 'sidebar.js'),
		path.join(__dirname, '..', '..', 'dist', 'sidebar.js'),
		path.join(process.cwd(), 'dist', 'sidebar.js'),
	]);
}

function pageStylePath(): string {
	return firstExisting([
		path.join(__dirname, '..', 'media', 'sidebar.css'),
		path.join(__dirname, '..', '..', '..', 'media', 'sidebar.css'),
		path.join(process.cwd(), 'media', 'sidebar.css'),
	]);
}

function firstExisting(candidates: readonly string[]): string {
	return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

/** One control page over the operations it drives, with the host parts a server can offer. */
function openPage(options: ControlPageOptions, log: Log): OpenPage {
	const control = new ControlPage(options.control, {
		openExternal: options.openExternal ?? (async url => { log(`The page shows this sign-in URL: ${url}`); }),
		copyToClipboard: options.copyToClipboard ?? (async text => { log(`The page asked to copy: ${text}`); }),
	});
	return { control, bundle: options.bundle ?? pageBundlePath(), style: options.style ?? pageStylePath() };
}

/**
 * The engine behind an OpenAI-compatible surface: chat completions over SSE or
 * one JSON body, the model list, a health probe, and the control page the
 * sidebar is built from. The client of a request runs the tools the agent calls,
 * so the endpoint returns `tool_calls` and the next request brings their results
 * back.
 */
export function createServer(options: HttpServerOptions): http.Server {
	const { composition, token } = options;
	const parking = new ToolCallParking(options.toolCallWaitMs ?? DEFAULT_TOOL_CALL_WAIT_MS, composition.host.log);
	const page = options.page ? openPage(options.page, composition.host.log) : undefined;
	const server = http.createServer((request, response) => {
		void handle(composition, token, parking, page, request, response);
	});
	// A stopped server has no client left to answer a parked call, so its timers
	// must not re-drive an agent on the way out.
	server.on('close', () => parking.dispose());
	return server;
}

async function handle(composition: HeadlessComposition, token: string | undefined, parking: ToolCallParking, page: OpenPage | undefined, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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
		if (page && request.method === 'GET' && pathname === '/') {
			sendPage(response);
			return;
		}
		if (page && request.method === 'GET' && pathname === '/sidebar.js') {
			await sendFile(response, page.bundle, 'text/javascript; charset=utf-8');
			return;
		}
		if (page && request.method === 'GET' && pathname === '/sidebar.css') {
			await sendFile(response, page.style, 'text/css; charset=utf-8');
			return;
		}
		if (pathname === STATE_ROUTE && request.method === 'GET') {
			sendJson(response, 200, page ? await page.control.state() : { agents: [] });
			return;
		}
		if (pathname === EVENTS_ROUTE && request.method === 'GET') {
			if (page) {
				streamState(page.control, response);
			} else {
				sendError(response, 404, 'This server has no control page.', 'invalid_request_error', 'not_found');
			}
			return;
		}
		if (pathname === ACTION_ROUTE && request.method === 'POST') {
			if (!page) {
				sendError(response, 404, 'This server has no control page.', 'invalid_request_error', 'not_found');
				return;
			}
			await runAction(page.control, request, response);
			return;
		}
		if (pathname === '/v1/models' && request.method === 'GET') {
			await sendModels(composition, response);
			return;
		}
		if (pathname === '/v1/chat/completions' && request.method === 'POST') {
			await complete(composition, parking, request, response);
			return;
		}
		sendError(response, 404, `No route for ${request.method ?? 'GET'} ${pathname}.`, 'invalid_request_error', 'not_found');
	} catch (error) {
		composition.host.log(`An HTTP request failed: ${messageOf(error)}`, 'error');
		sendError(response, 500, messageOf(error), 'server_error', 'internal_error');
	}
}

/** `GET /`: the shell the page's bundle and stylesheet load into. */
function sendPage(response: http.ServerResponse): void {
	const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/sidebar.css">
<style>${PAGE_THEME}</style>
<title>ACP Hub</title>
</head>
<body>
<div id="root"></div>
<script src="/sidebar.js"></script>
</body>
</html>`;
	response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
	response.end(body);
}

/**
 * The stylesheet uses VS Code's theme variables, which a browser does not
 * define. These values stand in for them, so the page keeps its layout and
 * becomes legible outside the editor; inside the webview this block is not
 * served at all and VS Code's own colours apply.
 */
const PAGE_THEME = `
:root {
	color-scheme: light dark;
	--vscode-foreground: #24292f;
	--vscode-descriptionForeground: #57606a;
	--vscode-sideBar-background: #ffffff;
	--vscode-panel-border: #d0d7de;
	--vscode-widget-border: #d0d7de;
	--vscode-button-background: #0969da;
	--vscode-button-foreground: #ffffff;
	--vscode-button-hoverBackground: #0860ca;
	--vscode-button-border: transparent;
	--vscode-button-secondaryBackground: #eaeef2;
	--vscode-button-secondaryForeground: #24292f;
	--vscode-badge-background: #0969da;
	--vscode-badge-foreground: #ffffff;
	--vscode-icon-foreground: #57606a;
	--vscode-errorForeground: #cf222e;
	--vscode-textLink-foreground: #0969da;
	--vscode-input-background: #ffffff;
	--vscode-input-foreground: #24292f;
	--vscode-input-border: #d0d7de;
	--vscode-progressBar-background: #0969da;
	--vscode-textCodeBlock-background: #f6f8fa;
	--vscode-toolbar-hoverBackground: #eaeef2;
	--vscode-editorHoverWidget-background: #ffffff;
	--vscode-editorHoverWidget-border: #d0d7de;
	--vscode-editorHoverWidget-foreground: #24292f;
	--vscode-font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	--vscode-font-size: 13px;
	--vscode-editor-font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
	:root {
		--vscode-foreground: #e6edf3;
		--vscode-descriptionForeground: #9198a1;
		--vscode-sideBar-background: #0d1117;
		--vscode-panel-border: #30363d;
		--vscode-widget-border: #30363d;
		--vscode-button-background: #238636;
		--vscode-button-foreground: #ffffff;
		--vscode-button-hoverBackground: #2ea043;
		--vscode-button-secondaryBackground: #21262d;
		--vscode-button-secondaryForeground: #e6edf3;
		--vscode-badge-background: #1f6feb;
		--vscode-badge-foreground: #ffffff;
		--vscode-icon-foreground: #9198a1;
		--vscode-errorForeground: #f85149;
		--vscode-textLink-foreground: #58a6ff;
		--vscode-input-background: #0d1117;
		--vscode-input-foreground: #e6edf3;
		--vscode-input-border: #30363d;
		--vscode-progressBar-background: #1f6feb;
		--vscode-textCodeBlock-background: #161b22;
		--vscode-toolbar-hoverBackground: #21262d;
		--vscode-editorHoverWidget-background: #161b22;
		--vscode-editorHoverWidget-border: #30363d;
		--vscode-editorHoverWidget-foreground: #e6edf3;
	}
}
html, body { height: 100%; }
body {
	margin: 0;
	padding: 0;
	background: var(--vscode-sideBar-background);
	color: var(--vscode-foreground);
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
}
#root {
	max-width: 780px;
	margin: 0 auto;
	padding: 20px 24px 48px;
}
@media (max-width: 480px) { #root { padding: 14px 14px 32px; } }
`;

/** One file the page loads, or a message that names the build it is missing from. */
async function sendFile(response: http.ServerResponse, file: string, contentType: string): Promise<void> {
	let body: Buffer;
	try {
		body = await fs.promises.readFile(file);
	} catch {
		sendError(response, 404, `The page file ${file} is not there; run "npm run compile" first.`, 'invalid_request_error', 'not_found');
		return;
	}
	response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.byteLength });
	response.end(body);
}

/** `POST /api/action`: one action the page sent, run against the same operations the sidebar uses. */
async function runAction(page: ControlPage, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
	let body: Record<string, unknown>;
	try {
		body = await readBody(request);
	} catch (error) {
		sendError(response, 400, messageOf(error), 'invalid_request_error', 'invalid_body');
		return;
	}
	if (typeof body.type !== 'string') {
		sendError(response, 400, 'The action has no "type".', 'invalid_request_error', 'invalid_body');
		return;
	}
	await page.handle(body as unknown as ControlAction);
	sendJson(response, 200, { ok: true });
}

/** `GET /api/events`: the state now, then every change, as server-sent events. */
function streamState(page: ControlPage, response: http.ServerResponse): void {
	response.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});
	const send = (state: ControlState): void => {
		if (!response.writableEnded && !response.destroyed) {
			response.write(`data: ${JSON.stringify(state)}\n\n`);
		}
	};
	// Subscribed before the first snapshot is read, so a change that lands while
	// it is built still reaches this client.
	const unsubscribe = page.onState(send);
	response.on('close', unsubscribe);
	void page.state().then(send, () => {
		unsubscribe();
		send({ agents: [] });
		response.end();
	});
}

/** `GET /health`: who the server is, the agents, whether each is installed, and how many chat sessions are open. */
async function sendHealth(composition: HeadlessComposition, response: http.ServerResponse): Promise<void> {
	const agents: HealthWire['agents'] = [];
	let openSessions = 0;
	for (const adapter of composition.adapters) {
		const service = composition.serviceOf(adapter.id);
		const sessions = service?.openSessions ?? 0;
		openSessions += sessions;
		agents.push({ id: adapter.id, installed: service !== undefined && await isInstalled(service, composition), openSessions: sessions });
	}
	const health: HealthWire = { status: 'ok', name: SERVER_NAME, version: VERSION, apiVersion: API_VERSION, openSessions, agents };
	sendJson(response, 200, health);
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
async function complete(composition: HeadlessComposition, parking: ToolCallParking, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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
	const chatRequest = chatRequestOf(composition, request, messages, toolsOf(body), target.model);
	// A turn the client continues after a tool call carries that call's result;
	// only a call this chat still holds may be settled, so a stale or foreign
	// call id is refused instead of resuming the wrong turn.
	const unpaid = takeToolResults(parking, chatRequest.chatId, messages);
	if (unpaid !== undefined) {
		sendError(response, 400, `No tool call "${unpaid}" is waiting for a result in this chat; it may have ended, or belong to another chat.`, 'invalid_request_error', 'tool_call_not_found');
		return;
	}
	// A turn the client continues after a tool call may arrive without its user
	// message again; anything else has to say something to the agent.
	const continuesATurn = messages.some(message => message.role === 'user' || message.parts.some(part => part.type === 'tool-result'));
	if (!continuesATurn) {
		sendError(response, 400, 'The request has no user message.', 'invalid_request_error', 'invalid_messages');
		return;
	}
	const client: TurnClient = {
		toolCall: event => parkTurnToolCall(parking, service, chatRequest, event, composition.host.log),
		disconnected: () => parking.clear(chatRequest.chatId),
	};
	if (body.stream === true) {
		await stream(service, chatRequest, model, response, client);
		return;
	}
	await collect(service, chatRequest, model, response, client);
}

/** What a response does when its turn hands it a call, or its client goes away. */
interface TurnClient {
	/** Keeps a call the response handed to the client, so a later request can settle it. */
	readonly toolCall: (event: Extract<StreamEvent, { type: 'tool-call' }>) => void;
	/** The client left while the turn ran, so no result for the calls of this response can come. */
	readonly disconnected: () => void;
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

/**
 * Takes the calls whose results this request returns, so their timers cannot
 * fail them afterwards, and names the first one the chat is not holding.
 */
function takeToolResults(parking: ToolCallParking, chatId: string, messages: readonly ChatMessage[]): string | undefined {
	// Results before the last assistant message answered earlier requests of the same turn; their calls are settled.
	const lastAssistant = messages.map(message => message.role).lastIndexOf('assistant');
	const results = messages.slice(lastAssistant + 1).flatMap(message => message.parts.filter((part): part is Extract<Part, { type: 'tool-result' }> => part.type === 'tool-result'));
	for (const result of results) {
		if (!parking.has(chatId, result.callId)) {
			return result.callId;
		}
	}
	for (const result of results) {
		parking.take(chatId, result.callId);
	}
	return undefined;
}

/** One JSON body: the turn is followed to its end, or to the tool calls the client has to run. */
async function collect(service: ChatService, request: ChatRequest, model: string, response: http.ServerResponse, client: TurnClient): Promise<void> {
	const turn = emptyTurn();
	const controller = new AbortController();
	const disconnected = (): void => {
		client.disconnected();
		controller.abort();
	};
	response.on('close', disconnected);
	try {
		await service.respond(request, event => {
			gather(turn, event);
			if (event.type === 'tool-call') {
				client.toolCall(event);
			}
		}, controller.signal);
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
async function stream(service: ChatService, request: ChatRequest, model: string, response: http.ServerResponse, client: TurnClient): Promise<void> {
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
	const disconnected = (): void => {
		client.disconnected();
		controller.abort();
	};
	response.on('close', disconnected);
	try {
		await service.respond(request, event => {
			gather(turn, event);
			if (event.type === 'text') {
				write(chunkOf(id, created, model, { content: event.text }, null));
			} else if (event.type === 'tool-call') {
				client.toolCall(event);
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

/** Keeps a call the response just handed to the client, so its result can be matched. */
function parkTurnToolCall(parking: ToolCallParking, service: ChatService, request: ChatRequest, event: Extract<StreamEvent, { type: 'tool-call' }>, log: Log): void {
	parking.park(request.chatId, event, () => {
		void failParkedToolCall(parking, service, request, event, log);
	});
}

/**
 * The client never returned a result. The agent is told the call failed, the
 * way the workbench tells it a tool did, so the engine settles the call instead
 * of holding it; what the agent says next has no response to stream into.
 */
async function failParkedToolCall(parking: ToolCallParking, service: ChatService, request: ChatRequest, call: Extract<StreamEvent, { type: 'tool-call' }>, log: Log): Promise<void> {
	// The conversation the client would have sent had it answered: the call, then its result.
	const continued: ChatRequest = {
		...request,
		messages: [
			...request.messages,
			{ role: 'assistant', parts: [{ type: 'tool-call', callId: call.callId, name: call.name, input: call.input }] },
			{ role: 'user', parts: [{ type: 'tool-result', callId: call.callId, content: [{ type: 'text', text: 'The client did not return a result for this tool call in time.' }], isError: true }] },
		],
	};
	try {
		await service.respond(continued, event => {
			if (event.type === 'tool-call') {
				parkTurnToolCall(parking, service, continued, event, log);
			}
		}, new AbortController().signal);
	} catch (error) {
		log(`Could not fail the expired tool call ${call.callId} of chat ${request.chatId}: ${messageOf(error)}`, 'warn');
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
		// The engine carries a tool's output in a user message, as the workbench
		// sends it, so a `tool` message becomes one the turn can settle its call
		// from; the engine's own turn reads no tool role.
		messages.push({ role: role === 'tool' ? 'user' : role, parts, ...(name ? { name } : {}) });
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
	// A `tool` message's content is the tool's output, which belongs inside its
	// result part, not beside it as text the user said.
	if (role !== 'tool') {
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
		const text = contentTextOf(message.content);
		parts.push({ type: 'tool-result', callId: typeof message.tool_call_id === 'string' ? message.tool_call_id : '', content: [{ type: 'text', text }], ...(isErrorText(text) ? { isError: true } : {}) });
	}
	return parts;
}

/** A client that ran a tool and failed it says so in the text: `error: …`, as MCP results do. */
function isErrorText(text: string): boolean {
	return /^\s*error\s*:/i.test(text);
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
