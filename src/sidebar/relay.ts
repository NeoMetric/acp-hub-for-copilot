/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Disposable } from '../engine/acp/emitter';
import type { Log } from '../engine/ports/host';
import type { LinkState, ServerEndpoint, ServerLink } from '../hosts/vscode/serverLink';
import type { AgentCardState, ControlAction, ControlState } from '../ui/messages';
import { ACTION_ROUTE, EVENTS_ROUTE, STATE_ROUTE, type ControlTransport } from '../ui/transport';

/** How long the relay waits before its first reconnect. */
const FIRST_RETRY_MS = 1_000;

/** How long it waits before every reconnect after that. */
const RETRY_MS = 5_000;

/** What the relay needs of the window it runs in. */
export interface SidebarRelayDeps {
	/** Where the server answers, and whether it is there at all. */
	readonly link: Pick<ServerLink, 'ensure' | 'onDidChange'>;
	/** Opens a URL in the window's browser. */
	openExternal(url: string): Promise<void>;
	/** Copies text to the window's clipboard. */
	copyToClipboard(text: string): Promise<void>;
	/** Whether the user agreed to uninstall the agent called `displayName`. */
	confirmUninstall(displayName: string): Promise<boolean>;
	readonly log: Log;
	readonly fetch?: typeof fetch;
}

/**
 * The sidebar's one connection to the server: it reads the state over
 * `/api/state`, follows the changes over `/api/events` and forwards what the
 * page asks for to `/api/action`, all with the link's bearer token. The token
 * never leaves this class, and nothing here knows which agent is which.
 *
 * A few actions stay in the window, where their answer is: the sign-in page is
 * opened or copied from the URL the state holds, and an uninstall is confirmed
 * first. While the server is away the page keeps drawing the last state it had,
 * with the link's reason on every card.
 */
export class SidebarRelay implements ControlTransport, Disposable {
	private readonly fetchOf: typeof fetch;
	private readonly listeners = new Set<(state: ControlState) => void>();
	private readonly timers = new Set<NodeJS.Timeout>();
	private readonly unsubscribeLink: () => void;
	/** The last state the server sent, which the page keeps drawing while the server is away. */
	private latest: ControlState | undefined;
	/** The last state handed to the page, so a `ready` can be answered without asking the server. */
	private delivered: ControlState | undefined;
	private attempt = 0;
	private started = false;
	private disposed = false;
	private current: AbortController | undefined;

	constructor(private readonly deps: SidebarRelayDeps) {
		this.fetchOf = deps.fetch ?? fetch;
		this.unsubscribeLink = deps.link.onDidChange(state => this.linkChanged(state));
	}

	send(action: ControlAction): void {
		if (action.type === 'ready') {
			if (this.delivered) {
				this.deliver(this.delivered);
			}
			return;
		}
		if (action.type === 'openSignInUrl' || action.type === 'copySignInUrl') {
			// The stored URL is used, never one that came from the page.
			const prompt = this.latest?.agents.find(agent => agent.id === action.agentId)?.signInUrl;
			if (!prompt) {
				return;
			}
			const use = action.type === 'copySignInUrl' ? this.deps.copyToClipboard(prompt.url) : this.deps.openExternal(prompt.url);
			void use.catch(error => this.deps.log(`Could not use the sign-in URL: ${messageOf(error)}`, 'warn'));
			return;
		}
		if (action.type === 'uninstall') {
			void this.confirmAndForward(action);
			return;
		}
		void this.forward(action);
	}

	onState(listener: (state: ControlState) => void): () => void {
		this.listeners.add(listener);
		this.start();
		return () => {
			this.listeners.delete(listener);
		};
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeLink();
		this.current?.abort();
		this.current = undefined;
		this.clearTimers();
		this.listeners.clear();
	}

	private start(): void {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;
		void this.connect();
	}

	/** Reads the state once, then follows the changes until the stream ends; a broken attempt retries. */
	private async connect(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.current?.abort();
		const abort = new AbortController();
		this.current = abort;
		const live = (): boolean => !this.disposed && this.current === abort && !abort.signal.aborted;

		const state = await this.deps.link.ensure().catch((): undefined => undefined);
		if (!live()) {
			return;
		}
		if (!state || state.kind !== 'ready') {
			const reason = state ? state.reason : 'The server could not be reached.';
			this.deliver(this.withLinkError(reason));
			this.retry();
			return;
		}
		await this.readState(state.endpoint, live);
		if (!live()) {
			return;
		}
		await this.follow(state.endpoint, abort);
		if (!live()) {
			return;
		}
		this.retry();
	}

	/** One read of `/api/state`; a failed read leaves the page drawing what it already had. */
	private async readState(endpoint: ServerEndpoint, live: () => boolean): Promise<void> {
		try {
			const response = await this.fetchOf(`${endpoint.baseUrl}${STATE_ROUTE}`, { headers: this.headersOf(endpoint) });
			if (!response.ok) {
				this.deps.log(`The sidebar could not read the server's state: HTTP ${response.status}.`, 'warn');
				return;
			}
			const value = await response.json() as unknown;
			if (live()) {
				this.accept(value);
			}
		} catch (error) {
			this.deps.log(`The sidebar could not read the server's state: ${messageOf(error)}`, 'warn');
		}
	}

	/** `/api/events`, frame by frame; a frame may arrive in pieces, so lines are counted, not chunks. */
	private async follow(endpoint: ServerEndpoint, abort: AbortController): Promise<void> {
		let response: Response;
		try {
			response = await this.fetchOf(`${endpoint.baseUrl}${EVENTS_ROUTE}`, {
				headers: { ...this.headersOf(endpoint), accept: 'text/event-stream' },
				signal: abort.signal,
			});
		} catch (error) {
			if (!abort.signal.aborted) {
				this.deps.log(`The sidebar lost the server's events: ${messageOf(error)}`, 'warn');
			}
			return;
		}
		if (!response.ok || !response.body) {
			this.deps.log(`The sidebar could not follow the server's events: HTTP ${response.status}.`, 'warn');
			return;
		}
		// A stream that opened is a server that is back, so the next drop retries quickly again.
		this.attempt = 0;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = '';
		let data: string[] = [];
		try {
			for (;;) {
				const chunk = await reader.read();
				if (abort.signal.aborted || chunk.done) {
					break;
				}
				pending += decoder.decode(chunk.value, { stream: true });
				let newline = pending.indexOf('\n');
				while (newline !== -1) {
					const line = pending.slice(0, newline).replace(/\r$/, '');
					pending = pending.slice(newline + 1);
					if (line === '') {
						if (data.length > 0) {
							this.accept(parseFrame(data.join('\n')));
							data = [];
						}
					} else if (line.startsWith('data:')) {
						data.push(line.slice('data:'.length).trimStart());
					}
					newline = pending.indexOf('\n');
				}
			}
		} catch (error) {
			if (!abort.signal.aborted) {
				this.deps.log(`The sidebar lost the server's events: ${messageOf(error)}`, 'warn');
			}
		}
		await reader.cancel().catch((): undefined => undefined);
	}

	/** One snapshot from the server: the page draws it, and a sign-in page it names opens once. */
	private accept(value: unknown): void {
		const state = value as ControlState | undefined;
		if (!state || !Array.isArray(state.agents)) {
			return;
		}
		const previous = this.latest;
		this.latest = state;
		this.deliver(state);
		for (const agent of state.agents) {
			if (agent.signInUrl && !signInUrlOf(previous, agent.id)) {
				const url = agent.signInUrl.url;
				void this.deps.openExternal(url).catch(error => this.deps.log(`Could not open the sign-in page: ${messageOf(error)}`, 'warn'));
			}
		}
	}

	private deliver(state: ControlState): void {
		this.delivered = state;
		for (const listener of [...this.listeners]) {
			listener(state);
		}
	}

	/** The last state with the link's reason on every card, or an empty page if the server never answered. */
	private withLinkError(reason: string): ControlState {
		const latest = this.latest;
		if (!latest) {
			return { agents: [] };
		}
		const agents: AgentCardState[] = latest.agents.map(agent => ({ ...agent, error: reason }));
		return { ...latest, agents };
	}

	private linkChanged(state: LinkState): void {
		if (this.disposed || !this.started) {
			return;
		}
		if (state.kind === 'ready') {
			this.attempt = 0;
			this.clearTimers();
			void this.connect();
			return;
		}
		this.current?.abort();
		this.current = undefined;
		this.deliver(this.withLinkError(state.reason));
	}

	private retry(): void {
		if (this.disposed) {
			return;
		}
		const delay = this.attempt === 0 ? FIRST_RETRY_MS : RETRY_MS;
		this.attempt += 1;
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			void this.connect();
		}, delay);
		timer.unref();
		this.timers.add(timer);
	}

	private clearTimers(): void {
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
		this.timers.clear();
	}

	private async confirmAndForward(action: Extract<ControlAction, { agentId: string }>): Promise<void> {
		const card = this.latest?.agents.find(agent => agent.id === action.agentId);
		if (!card) {
			return;
		}
		let confirmed: boolean;
		try {
			confirmed = await this.deps.confirmUninstall(card.displayName);
		} catch (error) {
			this.deps.log(`Could not ask about uninstalling ${card.displayName}: ${messageOf(error)}`, 'warn');
			return;
		}
		if (confirmed) {
			await this.forward(action);
		}
	}

	private async forward(action: ControlAction): Promise<void> {
		const state = await this.deps.link.ensure().catch((): undefined => undefined);
		if (!state || state.kind !== 'ready') {
			this.deps.log(`The sidebar dropped its ${action.type} action: the server is not reachable.`, 'warn');
			return;
		}
		try {
			const response = await this.fetchOf(`${state.endpoint.baseUrl}${ACTION_ROUTE}`, {
				method: 'POST',
				headers: { ...this.headersOf(state.endpoint), 'content-type': 'application/json' },
				body: JSON.stringify(action),
			});
			if (!response.ok) {
				this.deps.log(`The server refused the sidebar's ${action.type} action: HTTP ${response.status}.`, 'warn');
			}
		} catch (error) {
			this.deps.log(`The sidebar could not send its ${action.type} action: ${messageOf(error)}`, 'warn');
		}
	}

	/** The bearer token travels in a header, and nowhere else. */
	private headersOf(endpoint: ServerEndpoint): Record<string, string> {
		return endpoint.token === undefined ? {} : { authorization: `Bearer ${endpoint.token}` };
	}
}

function signInUrlOf(state: ControlState | undefined, agentId: string): { url: string; message: string } | undefined {
	return state?.agents.find(agent => agent.id === agentId)?.signInUrl;
}

function parseFrame(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
