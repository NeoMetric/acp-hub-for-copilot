/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Emitter, type CancellationToken, type Disposable } from '../acp/emitter';
import type { ToolDef } from '../model/chat';
import type { Log } from '../ports/host';

/** Where an ACP session reaches its own tool set. */
export interface McpServerEndpoint {
	readonly url: string;
	readonly token: string;
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * How often an idle notification stream gets a comment line. Claude Code ends a silent stream
 * after about 6 minutes and then gives up on every tool call still waiting 90 seconds later,
 * which loses the answer to a question the user is still thinking about.
 */
const STREAM_HEARTBEAT_MS = 20_000;
/**
 * How many notification streams one ACP session keeps open. A client that
 * reconnects without closing the stream it had would otherwise leave one
 * heartbeat per attempt running for as long as the process lives.
 */
export const MAX_STREAMS_PER_SESSION = 8;

/** The content of one tool call, in the shape the caller returned it. */
export interface McpToolResult {
	readonly content: ReadonlyArray<unknown>;
	readonly isError?: boolean;
}

/**
 * Runs a tool call on behalf of the caller of the language model request.
 *
 * Returns `undefined` when no caller owns the call. The bridge then reports an
 * error to the agent instead of running the tool itself: a tool run without a
 * chat to own it would skip the confirmation Copilot shows for it.
 */
export type McpToolExecutor = (name: string, input: unknown, token: CancellationToken) => Promise<McpToolResult | undefined>;

interface McpSession {
	/** The tools the chat may use now; a call to any other is refused. */
	readonly tools: readonly ToolDef[];
	/**
	 * Every tool the session has listed, including ones withdrawn since. The agent's tool block
	 * leads its prompt cache, so dropping a tool from the list would miss the whole cache.
	 */
	readonly listed: ReadonlyMap<string, ToolDef>;
	readonly execute: McpToolExecutor;
	/** The most characters of text a result may carry to the agent; absent passes results whole. */
	readonly maxResultChars?: number;
}

/** What an agent session needs from the bridge besides its tools. */
export interface McpSessionOptions {
	readonly maxResultChars?: number;
}

interface JsonRpcMessage {
	readonly jsonrpc?: string;
	readonly id?: number | string | null;
	readonly method?: string;
	readonly params?: unknown;
}

class McpError extends Error {

	constructor(message: string, readonly code: number) {
		super(message);
	}
}

/**
 * Raises cancellation for one tool call and hands out the token that reports it;
 * the engine's stand-in for a host's own cancellation source.
 */
export class CancellationSource implements CancellationToken {

	private requested = false;
	private readonly emitter = new Emitter<void>();

	/** The token to pass with the call; the source reports its own cancellation. */
	get token(): CancellationToken {
		return this;
	}

	get isCancellationRequested(): boolean {
		return this.requested;
	}

	onCancellationRequested(listener: () => unknown): Disposable {
		return this.emitter.event(listener);
	}

	cancel(): void {
		if (!this.requested) {
			this.requested = true;
			this.emitter.fire(undefined);
		}
	}

	/** Releases the token's listeners, which a call that ended no longer needs. */
	dispose(): void {
		this.emitter.dispose();
	}
}

/**
 * Loopback MCP server that exposes the Copilot tools of one chat to the agent.
 *
 * Every ACP session gets its own bearer token, so a session can only see the
 * tools of the chat that created it.
 */
export class McpBridge implements Disposable {

	private server: http.Server | undefined;
	private starting: Promise<void> | undefined;
	private readonly sessions = new Map<string, McpSession>();
	/** The open notification streams of each session, by token. */
	private readonly streams = new Map<string, Set<http.ServerResponse>>();
	/** The heartbeat of each stream, so closing a stream or the bridge stops it. */
	private readonly heartbeats = new Map<http.ServerResponse, NodeJS.Timeout>();
	private disposed = false;
	/** Bumped when the bridge is drained, so a start that was overtaken closes its server. */
	private generation = 0;

	constructor(private readonly log: Log, private readonly heartbeatMs = STREAM_HEARTBEAT_MS, private readonly maxStreams = MAX_STREAMS_PER_SESSION) { }

	/** How many notification streams are open, for the host that reports its health. */
	get openStreams(): number {
		let count = 0;
		for (const streams of this.streams.values()) {
			count += streams.size;
		}
		return count;
	}

	/** How many heartbeats run; a drained bridge has none. */
	get activeHeartbeats(): number {
		return this.heartbeats.size;
	}

	/** Registers a tool set for a new ACP session and returns its endpoint. */
	async registerSession(tools: readonly ToolDef[], execute: McpToolExecutor, options: McpSessionOptions = {}): Promise<McpServerEndpoint> {
		await this.ensureStarted();

		const token = crypto.randomUUID();
		this.sessions.set(token, { tools, listed: new Map(tools.map(tool => [tool.name, tool])), execute, maxResultChars: options.maxResultChars });

		const address = this.server?.address() as AddressInfo | null;
		if (!address || typeof address === 'string') {
			throw new Error("The tool bridge is not listening.");
		}

		this.log(`Registered MCP session with ${tools.length} tool(s) on port ${address.port}`, 'debug');
		return { url: `http://127.0.0.1:${address.port}/`, token };
	}

	/**
	 * Replaces the tool set of an existing ACP session and tells the agent, so a
	 * tool the user just disabled stops being offered and one just enabled starts
	 * being callable without starting a new session. A tool taken away stays in the
	 * list the agent sees, so its cached prompt survives, but a call to it is refused.
	 */
	updateTools(token: string, tools: readonly ToolDef[]): void {
		const session = this.sessions.get(token);
		if (!session) {
			return;
		}
		const listed = new Map(session.listed);
		for (const tool of tools) {
			listed.set(tool.name, tool);
		}
		this.sessions.set(token, { ...session, tools, listed });
		if (listed.size === session.listed.size && [...listed.keys()].every(name => session.listed.has(name))) {
			return;
		}

		this.log(`Tool set of an agent session grew to ${listed.size} listed tool(s) (${tools.length} callable); telling the agent.`, 'debug');
		this.notify(token, 'notifications/tools/list_changed');
	}

	unregisterSession(token: string): void {
		this.sessions.delete(token);
		this.closeStreams(token);
	}

	dispose(): void {
		this.disposed = true;
		this.drain();
	}

	/**
	 * Closes every notification stream, stops their heartbeats and stops the
	 * server, so a host that is going away leaves no timer behind. A drained
	 * bridge starts again on the next session it is asked for.
	 */
	drain(): void {
		this.generation++;
		for (const token of [...this.streams.keys()]) {
			this.closeStreams(token);
		}
		for (const heartbeat of this.heartbeats.values()) {
			clearInterval(heartbeat);
		}
		this.heartbeats.clear();
		this.sessions.clear();
		this.server?.close();
		this.server = undefined;
	}

	private async ensureStarted(): Promise<void> {
		if (this.disposed) {
			throw new Error("The tool bridge has been disposed.");
		}
		if (this.server) {
			return;
		}
		if (!this.starting) {
			this.starting = this.startServer().finally(() => {
				this.starting = undefined;
			});
		}
		return this.starting;
	}

	private startServer(): Promise<void> {
		const generation = this.generation;
		return new Promise<void>((resolve, reject) => {
			const server = http.createServer((request, response) => {
				void this.handleRequest(request, response).catch(error => {
					this.log(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
				});
			});

			const onError = (error: Error) => reject(error);
			server.on('error', onError);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', onError);
				// The bridge was drained while the server was binding: nothing may use it now.
				if (generation !== this.generation) {
					server.close();
					reject(new Error('The tool bridge was drained while it was starting.'));
					return;
				}
				server.keepAliveTimeout = 120_000;
				server.headersTimeout = 125_000;
				// A tool call waits for the chat that owns it, which can take as long
				// as a user needs to approve the tool.
				server.requestTimeout = 0;
				this.server = server;
				const address = server.address() as AddressInfo;
				this.log(`MCP tool bridge listening on 127.0.0.1:${address.port}`);
				resolve();
			});
		});
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		// A browser page cannot reach a loopback server it does not know the token of, but
		// refusing foreign Host and Origin headers also closes off DNS rebinding.
		if (request.headers.origin !== undefined || !isLoopbackHost(request.headers.host)) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}

		const session = this.authenticate(request);
		if (!session) {
			sendJson(response, 401, { error: "Unauthorized" });
			return;
		}

		if (request.method === 'GET') {
			// The agent keeps this stream open to hear that the tool list changed.
			this.openStream(this.tokenOf(request), response);
			return;
		}

		if (request.method !== 'POST') {
			response.setHeader('allow', 'GET, POST');
			sendJson(response, 405, { error: "Method not allowed" });
			return;
		}

		const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
		if (pathname !== '/' && pathname !== '/mcp') {
			sendJson(response, 404, { error: "Not found" });
			return;
		}

		let body: string;
		try {
			body = await readBody(request);
		} catch (error) {
			sendJson(response, 413, { error: error instanceof Error ? error.message : String(error) });
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			sendJson(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}

		const messages = Array.isArray(parsed) ? parsed as JsonRpcMessage[] : [parsed as JsonRpcMessage];
		const responses: object[] = [];

		for (const message of messages) {
			if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
				if (message && typeof message === 'object' && message.id !== undefined) {
					responses.push({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Invalid request" } });
				}
				continue;
			}
			const result = await this.createResponse(message, session, response);
			if (result) {
				responses.push(result);
			}
		}

		if (responses.length === 0) {
			// Notifications only, e.g. `notifications/initialized`.
			response.writeHead(202, { 'cache-control': 'no-store' });
			response.end();
			return;
		}

		sendJson(response, 200, Array.isArray(parsed) ? responses : responses[0]);
	}

	private authenticate(request: http.IncomingMessage): McpSession | undefined {
		const header = request.headers.authorization;
		if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
			return undefined;
		}

		// The token is a random UUID handed to one ACP session over stdio, and the
		// server only listens on loopback, so a direct lookup is enough.
		return this.sessions.get(header.slice('Bearer '.length));
	}

	/** The token a request authenticated with, which names its session and its streams. */
	private tokenOf(request: http.IncomingMessage): string {
		return (request.headers.authorization ?? '').slice('Bearer '.length);
	}

	/** Opens the server-to-client stream an MCP client reads notifications from. */
	private openStream(token: string, response: http.ServerResponse): void {
		response.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			'connection': 'keep-alive',
		});
		// An idle stream is normal: the tool list changes only when the user does.
		response.setTimeout(0);
		response.write(': waiting for notifications\n\n');

		const streams = this.streams.get(token) ?? new Set<http.ServerResponse>();
		streams.add(response);
		this.streams.set(token, streams);

		const heartbeat = setInterval(() => {
			if (!response.writableEnded && !response.destroyed) {
				response.write(': ping\n\n');
			}
		}, this.heartbeatMs);
		heartbeat.unref();
		this.heartbeats.set(response, heartbeat);

		const forget = (): void => this.forgetStream(token, response);
		response.on('close', forget);
		response.on('error', forget);

		this.log(`Opened a notification stream for an agent session (${streams.size} open).`, 'debug');
		// A client that reconnects without closing the stream it had would leave one
		// heartbeat per attempt; the newest streams are the ones the agent reads.
		while (streams.size > this.maxStreams) {
			const oldest = streams.values().next().value;
			if (!oldest) {
				break;
			}
			this.log(`Closing the oldest notification stream of an agent session: ${this.maxStreams} is the most one keeps.`, 'debug');
			this.forgetStream(token, oldest);
			if (!oldest.writableEnded && !oldest.destroyed) {
				oldest.end();
			}
		}
	}

	/** Forgets one stream: its heartbeat stops, and its session forgets it once none is left. */
	private forgetStream(token: string, response: http.ServerResponse): void {
		const heartbeat = this.heartbeats.get(response);
		if (heartbeat) {
			clearInterval(heartbeat);
			this.heartbeats.delete(response);
		}
		const streams = this.streams.get(token);
		if (!streams) {
			return;
		}
		streams.delete(response);
		if (streams.size === 0 && this.streams.get(token) === streams) {
			this.streams.delete(token);
		}
	}

	/** Writes one JSON-RPC notification to every open stream of a session. */
	private notify(token: string, method: string, params?: unknown): void {
		const streams = this.streams.get(token);
		if (!streams || streams.size === 0) {
			return;
		}

		const message = JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
		for (const stream of streams) {
			if (stream.writableEnded || stream.destroyed) {
				continue;
			}
			stream.write(`event: message\ndata: ${message}\n\n`);
		}
		this.log(`Sent ${method} to ${streams.size} notification stream(s).`, 'debug');
	}

	private closeStreams(token: string): void {
		const streams = this.streams.get(token);
		this.streams.delete(token);
		for (const stream of streams ?? []) {
			const heartbeat = this.heartbeats.get(stream);
			if (heartbeat) {
				clearInterval(heartbeat);
				this.heartbeats.delete(stream);
			}
			if (!stream.writableEnded && !stream.destroyed) {
				stream.end();
			}
		}
	}

	private async createResponse(message: JsonRpcMessage, session: McpSession, response: http.ServerResponse): Promise<object | undefined> {
		const id = message.id;
		if (id === undefined || id === null) {
			// A notification needs no answer.
			return undefined;
		}

		try {
			const result = await this.invoke(message, session, response);
			return { jsonrpc: "2.0", id, result };
		} catch (error) {
			if (error instanceof McpError) {
				return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
			}
			const text = error instanceof Error ? error.message : String(error);
			this.log(`MCP request ${message.method} failed: ${text}`, 'error');
			return { jsonrpc: "2.0", id, error: { code: -32603, message: text } };
		}
	}

	private async invoke(message: JsonRpcMessage, session: McpSession, response: http.ServerResponse): Promise<unknown> {
		switch (message.method) {
			case 'initialize':
				return this.initialize(message.params);

			case 'ping':
				return {};

			case 'tools/list':
				this.log(`Listing ${session.listed.size} tool(s) for an agent session`, 'debug');
				return {
					// By name, so a request that lists the same tools in another order does not change the agent's tool block.
					tools: [...session.listed.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)).map(tool => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
					})),
				};

			case 'tools/call':
				return this.callTool(message.params, session, response);

			default:
				throw new McpError(`Method not found: ${message.method}`, -32601);
		}
	}

	private initialize(params: unknown): unknown {
		const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
		const protocolVersion = typeof requested === 'string' && KNOWN_PROTOCOL_VERSIONS.has(requested)
			? requested
			: DEFAULT_PROTOCOL_VERSION;

		return {
			protocolVersion,
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: 'vscode', version: '1.0.0' },
		};
	}

	private async callTool(params: unknown, session: McpSession, response: http.ServerResponse): Promise<unknown> {
		const request = (params ?? {}) as { name?: unknown; arguments?: unknown };
		const name = request.name;
		if (typeof name !== 'string' || name.length === 0) {
			throw new McpError("tools/call requires a tool name", -32602);
		}
		// Arguments can quote commands and file contents, so they are debug-level.
		this.log(`tools/call ${name} arguments: ${stringify(request.arguments ?? {})}`, 'debug');

		if (!session.tools.some(tool => tool.name === name)) {
			return { content: [{ type: 'text', text: `Tool ${name} is not available in this session.` }], isError: true };
		}

		const cancellation = new CancellationSource();
		const onClose = () => {
			if (!response.writableFinished) {
				cancellation.cancel();
			}
		};
		response.on('close', onClose);

		try {
			// The caller of the language model request owns tool execution: it can
			// run tools this extension cannot see, such as the ones of a Copilot
			// agent session.
			const forwarded = await session.execute(name, request.arguments ?? {}, cancellation.token);
			if (forwarded) {
				this.log(`Returned tool ${name} to the caller of the request`, 'debug');
				const content = toMcpContent(forwarded.content);
				return {
					content: session.maxResultChars === undefined ? content : limitTextContent(content, session.maxResultChars, this.log),
					...(forwarded.isError ? { isError: true } : {}),
				};
			}

			this.log(`Tool ${name} was requested while no chat response could run it; refusing`, 'warn');
			return {
				content: [{ type: 'text', text: `Tool ${name} was not run. The user cancelled the tool call.` }],
				isError: true,
			};
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.log(`Tool ${name} failed: ${text}`, 'error');
			return { content: [{ type: 'text', text }], isError: true };
		} finally {
			response.off('close', onClose);
			cancellation.dispose();
		}
	}
}

function isLoopbackHost(host: string | undefined): boolean {
	return host === undefined || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

export function toMcpContent(content: ReadonlyArray<unknown>): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];

	for (const part of content) {
		if (isDataPart(part)) {
			if (part.mimeType.startsWith('image/')) {
				blocks.push({ type: 'image', data: Buffer.from(part.data).toString('base64'), mimeType: part.mimeType });
			} else {
				blocks.push({ type: 'text', text: Buffer.from(part.data).toString('utf8') });
			}
		} else if (isTextPart(part)) {
			blocks.push({ type: 'text', text: part.value });
		} else if (typeof part === 'string') {
			blocks.push({ type: 'text', text: part });
		} else if (part !== undefined && part !== null) {
			blocks.push({ type: 'text', text: stringify(part) });
		}
	}

	return blocks;
}

/** A text part of any host, recognised by the field it carries rather than by its class. */
function isTextPart(part: unknown): part is { readonly value: string } {
	return typeof part === 'object' && part !== null && typeof (part as { value?: unknown }).value === 'string';
}

/** A binary part of any host, recognised by the fields it carries rather than by its class. */
function isDataPart(part: unknown): part is { readonly data: Uint8Array; readonly mimeType: string } {
	if (typeof part !== 'object' || part === null) {
		return false;
	}
	const candidate = part as { data?: unknown; mimeType?: unknown };
	return candidate.data instanceof Uint8Array && typeof candidate.mimeType === 'string';
}

/**
 * Cuts the text of a result to `maxChars` and appends a note on how to read the rest, so the agent
 * gets the start of the result in place of one it would take out of the conversation. Images stay.
 */
export function limitTextContent(content: Array<Record<string, unknown>>, maxChars: number, log?: Log): Array<Record<string, unknown>> {
	const total = content.reduce((sum, block) => sum + (block.type === 'text' ? String(block.text).length : 0), 0);
	if (total <= maxChars) {
		return content;
	}

	const limited: Array<Record<string, unknown>> = [];
	let remaining = maxChars;
	for (const block of content) {
		if (block.type !== 'text') {
			limited.push(block);
			continue;
		}
		const text = String(block.text);
		if (text.length <= remaining) {
			limited.push(block);
			remaining -= text.length;
		} else if (remaining > 0) {
			// Whole lines when there is one to end on, so a cut does not leave half a line to be mistaken for the real one.
			const newline = text.lastIndexOf('\n', remaining);
			limited.push({ ...block, text: text.slice(0, newline > 0 ? newline : remaining) });
			remaining = 0;
		}
	}
	const shown = limited.reduce((sum, block) => sum + (block.type === 'text' ? String(block.text).length : 0), 0);
	limited.push({ type: 'text', text: `\n[Output cut: ${shown} of ${total} characters shown. Ask for a smaller part of it to read the rest, for example a \`view_range\` of a file or a narrower search.]` });
	log?.(`A tool result of ${total} character(s) was cut to ${shown} for the agent.`, 'debug');
	return limited;
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function readBody(request: http.IncomingMessage): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;

		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
	if (response.headersSent || response.writableEnded || response.destroyed) {
		response.end();
		return;
	}
	response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	response.end(JSON.stringify(body));
}
