/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AcpSessionUpdate } from '../acp/agentClient';
import type { StreamEvent } from '../model/stream';
import type { AcpContentBlock, AcpTokenUsage } from '../acp/protocol';
import { RpcConnectionClosedError } from '../acp/rpc';
import type { AgentAdapter, AgentSettings } from '../../core/adapter';
import { effectiveToolWaitMs, type SessionPolicy } from '../../core/sessionPolicy';
import type { RequestMeasurement } from './cache';
import { checkpointOf, noteAgentUpdate } from './checkpoints';
import { CANCELLED_TOOL_CALL, clearToolDeadline, disposeCancellations, failPendingToolCalls, releaseHeldToolCalls, sleepUntilActivity, trackCancellation, wakeTurn, watchToolCalls } from './heldCalls';
import { keepsSessionAfterFailure } from './keys';
import type { Log } from '../ports/host';
import { rememberSession } from './reuse';
import type { SavedSessionStore } from './sessionStore';
import { describe } from './sessionOptions';
import type { ActiveTurn, AgentApi, ChatSession, FinishedTurn } from './types';
import { addModelCall, logCache, logContextCall, logReuseVerdict, logTokens, reportUsage, warnIfCallsMissing } from './usageReport';
import { ChatError } from './ChatError';

/**
 * How long to collect tool calls before handing a turn back to the host, so
 * calls the agent issued in parallel travel in the same response.
 */
const PARALLEL_TOOL_WINDOW_MS = 250;
/** How long to wait for an abandoned turn to end before moving on. */
const ABANDONED_TURN_WAIT_MS = 5_000;

/** What the turns need from the service that owns them. */
export interface TurnHost {
	adapter: AgentAdapter;
	log: Log;
	saved: SavedSessionStore;
	/** The session policy to ask, and the settings it reads: a tool call's wait comes from them. */
	policy(): SessionPolicy;
	settings(): AgentSettings | undefined;
	/** The agent process of a session; each workspace has its own. */
	agentOf(session: ChatSession): AgentApi;
	/** Shares a context window the agent reported with whoever lists the models. */
	refineWindow?(model: string, size: number): void;
	finished(turn: FinishedTurn): void;
	measured(measurement: RequestMeasurement): void;
	destroySession(key: string): Promise<void>;
	isSignInRequired(error: unknown): boolean;
	promptSignIn(): void;
	needsCredentials(): string;
	/** Whether the service stopped the agent itself, so a turn it was serving ends with it. */
	stopping?(): boolean;
}

export class TurnRunner {

	constructor(private readonly host: TurnHost) { }

	private get log(): Log {
		return this.host.log;
	}

	/** Whether the agent reports the usage of each model call, not only of the turn. */
	private get reportsEachModelCall(): boolean {
		return this.host.adapter.modelCallUsage !== undefined;
	}

	start(session: ChatSession, sink: (event: StreamEvent) => void, signal: AbortSignal, blocks: readonly AcpContentBlock[]): ActiveTurn {
		// The prompt's callbacks need the turn, and the turn needs the prompt: it is
		// assigned right below, before any callback can run.
		// eslint-disable-next-line prefer-const
		let turn: ActiveTurn;
		let sawOutput = false;
		const firstOutput = (what: string): void => {
			if (!sawOutput) {
				sawOutput = true;
				this.log(`[timing] First ${what} from the agent ${Date.now() - turn.startedAt}ms after the prompt was sent.`, 'debug');
			}
		};

		const prompt = this.host.agentOf(session).prompt(session.acp.sessionId, blocks, {
			onText: text => {
				firstOutput('text');
				turn.characters += text.length;
				if (turn.streaming) {
					turn.sink({ type: 'text', text });
				}
			},
			onThought: text => {
				firstOutput('thinking');
				turn.thoughtCharacters = (turn.thoughtCharacters ?? 0) + text.length;
				if (turn.streaming) {
					turn.sink({ type: 'thought', text });
				}
			},
			onUpdate: (update: AcpSessionUpdate) => {
				if (update.sessionUpdate === 'tool_call') {
					firstOutput('tool call');
				}
				this.handleUpdate(session, turn, update);
			},
			onUsage: this.reportsEachModelCall ? usage => this.measureRequest(session, turn, usage) : undefined,
		}).then(
			async result => {
				turn.result = result;
				await this.refreshLastCall(session, turn);
				if (result.usage && this.host.adapter.reportsCache === false) {
					logTokens(result.usage, this.log);
				} else if (result.usage && !this.reportsEachModelCall) {
					logCache('Turn cache', result.usage, this.log, turn.contextCalls);
					logReuseVerdict(session, result.usage, 'turn', this.log);
				}
				return result;
			},
			error => {
				turn.error = error;
				if (!turn.streaming && !signal.aborted) {
					this.log(`Agent turn failed while waiting for a tool result: ${describe(error)}`, 'error');
				}
				throw error;
			},
		).finally(() => {
			turn.finished = true;
			wakeTurn(turn);
		});

		turn = {
			sink,
			prompt,
			sessionId: session.acp.sessionId,
			finished: false,
			streaming: true,
			pending: new Map(),
			held: [],
			cancellations: [],
			waiters: [],
			toolCalls: 0,
			characters: 0,
			contextCalls: 0,
			contextSent: 0,
			reportedTokens: 0,
			agentMessages: [],
			contextUsed: session.contextUsed,
			startedAt: Date.now(),
		};

		// The turn can outlive this request; its failure is reported by the request
		// that continues it, so it must not surface as an unhandled rejection.
		void prompt.catch(() => undefined);
		return turn;
	}

	/**
	 * Reads the last model call of a session whose agent sends no `usage_update`, so the context
	 * the host shows is the one the agent holds and not the sum of every call of the turn.
	 */
	private async refreshLastCall(session: ChatSession, turn: ActiveTurn): Promise<void> {
		const lastModelCall = this.host.adapter.lastModelCall;
		if (!lastModelCall || turn.contextUsed !== undefined) {
			return;
		}
		try {
			const call = await lastModelCall(session.acp.sessionId);
			if (call) {
				turn.lastCall = call;
			}
		} catch (error) {
			this.log(`Could not read the last model call of ${session.acp.sessionId}: ${describe(error)}`, 'debug');
		}
	}

	private handleUpdate(session: ChatSession, turn: ActiveTurn, update: AcpSessionUpdate): void {
		noteAgentUpdate(turn.agentMessages, update);
		if (update.sessionUpdate === 'tool_call') {
			turn.toolCalls++;
			return;
		}
		if (update.sessionUpdate !== 'usage_update') {
			return;
		}
		if (typeof update.used === 'number') {
			turn.contextUsed = update.used;
			session.contextUsed = update.used;
			if (!this.reportsEachModelCall) {
				logContextCall(turn, update.used, update.size, this.log);
			}
		}
		if (typeof update.size === 'number' && update.size !== turn.contextSize) {
			turn.contextSize = update.size;
			if (this.host.adapter.modelPolicy.refineWindowFromUsage) {
				this.host.refineWindow?.(session.model, update.size);
			}
		}
	}

	/** Adds one model call of a running turn and reports it at once, so the cache figure follows the turn. */
	private measureRequest(session: ChatSession, turn: ActiveTurn, call: AcpTokenUsage): void {
		const total = addModelCall(turn, call);
		logCache('Model call', call, this.log);
		logReuseVerdict(session, call, 'model call', this.log);
		this.host.measured({ call, turn: total, background: session.toolCount === 0, chat: session.chat });
	}

	/** Streams a turn into the current response until it finishes or needs a tool. */
	async drive(key: string, session: ChatSession, sink: (event: StreamEvent) => void, signal: AbortSignal, fingerprints: readonly string[], lastUser: number): Promise<void> {
		const turn = session.turn;
		if (!turn) {
			return;
		}
		turn.sink = sink;
		turn.streaming = true;
		clearToolDeadline(turn);
		releaseHeldToolCalls(turn, this.log);
		trackCancellation(turn, signal, () => this.host.agentOf(session).cancel(session.acp.sessionId), this.log);

		try {
			while (!turn.finished) {
				if (turn.pending.size > 0) {
					// Give the agent a moment to issue parallel calls so all of them can
					// travel in this response.
					await delay(PARALLEL_TOOL_WINDOW_MS);
					await this.refreshLastCall(session, turn);
					reportUsage(turn, this.log);
					turn.streaming = false;
					this.watchTools(key, session, turn);
					this.log(`Turn for ${key} asked for ${turn.pending.size} tool call(s); returning them to the host.`, 'debug');
					return;
				}
				await Promise.race([sleepUntilActivity(turn), turn.prompt.then(() => undefined, () => undefined)]);
			}
		} finally {
			// A response that ended without handing over a tool call leaves the turn
			// without a stream; calls that arrive then wait for the next request.
			if (!turn.finished) {
				turn.streaming = false;
			}
		}

		session.turn = undefined;
		session.lastActive = Date.now();
		clearToolDeadline(turn);
		disposeCancellations(turn);
		failPendingToolCalls(turn, new Error("The turn ended before the tool result arrived."));

		if (turn.error) {
			await this.failTurn(key, session, turn, signal, fingerprints, lastUser);
			return;
		}

		session.history.length = 0;
		session.history.push(...fingerprints);
		session.failures = 0;
		// The agent's reply that ends the turn is the message after the last one of the request.
		const checkpoint = checkpointOf(turn.agentMessages, session.messageCounts, fingerprints.length + 1);
		if (checkpoint) {
			session.checkpoints.push(checkpoint);
			this.log(`[checkpoint] ${key}: after ${checkpoint.messages} message(s), agent message ${checkpoint.messageId}, ${checkpoint.fingerprint.slice(0, 15)}… occurrence ${checkpoint.occurrence}.`, 'debug');
		} else {
			this.log(`[checkpoint] ${key}: the turn did not end on a message of the agent's; no fork point recorded.`, 'debug');
		}
		rememberSession(this.host.saved, key, session, fingerprints, this.log);

		reportUsage(turn, this.log);
		const reported = turn.result?.usage;
		if (this.reportsEachModelCall) {
			warnIfCallsMissing(turn.requestUsage, reported, this.log);
		}
		this.host.finished({ usage: reported, background: session.toolCount === 0, chat: session.chat, model: session.model, contextUsed: turn.contextUsed ?? turn.lastCall?.promptTokens, contextSize: turn.contextSize });

		const stopReason = turn.result?.stopReason ?? 'unknown';
		this.log(`Turn finished in ${Date.now() - turn.startedAt}ms: ${turn.characters} character(s), ${turn.thoughtCharacters ?? 0} of thinking, ${turn.toolCalls} tool call(s), stop reason "${stopReason}".`);
		if (stopReason === 'cancelled' && !signal.aborted) {
			this.log('The agent cancelled the turn on its own.', 'warn');
		}
		turn.sink({ type: 'done', stopReason });
	}

	/** Settles a failed turn: keeps or replaces the session, then fails the request with a readable message. */
	private async failTurn(key: string, session: ChatSession, turn: ActiveTurn, signal: AbortSignal, fingerprints: readonly string[], lastUser: number): Promise<void> {
		const name = this.host.adapter.displayName;
		this.log(`Turn failed after ${Date.now() - turn.startedAt}ms: ${describe(turn.error)}`, 'error');

		// The service stopped the agent itself. The turn died with it, and there is no
		// session left to keep or to replace, so the request ends quietly.
		if (this.host.stopping?.() === true) {
			return;
		}

		// A failed turn is no reason to drop the session: the agent still holds the
		// conversation, and the next request reads it from the prompt cache instead
		// of paying for all of it again. The messages of the failed turn count as
		// seen, since the agent was given them, except the user message itself:
		// Retry resends the same messages and that one has to reach the agent. A
		// session that keeps failing, a connection that is gone or a missing
		// sign-in is replaced instead.
		session.failures += 1;
		if (keepsSessionAfterFailure(turn.error, session.failures, this.host.isSignInRequired(turn.error))) {
			session.history.length = 0;
			session.history.push(...fingerprints.slice(0, lastUser));
		} else {
			await this.host.destroySession(key);
		}

		if (this.host.isSignInRequired(turn.error)) {
			this.host.promptSignIn();
			throw new ChatError(this.host.needsCredentials());
		}
		if (turn.error instanceof RpcConnectionClosedError) {
			throw new ChatError(`The ${name} agent stopped. Send your message again to start a new session; if it keeps happening, restart the agent from the ACP Hub sidebar.`);
		}
		if (signal.aborted) {
			return;
		}
		throw new ChatError(`${name} failed: ${describe(turn.error)}`);
	}

	/** After the response handed tools over, fails them if the host never comes back before the policy's wait. */
	private watchTools(key: string, session: ChatSession, turn: ActiveTurn): void {
		const timeoutMs = effectiveToolWaitMs(this.host.policy(), this.host.settings() ?? {});
		if (!Number.isFinite(timeoutMs)) {
			return;
		}
		watchToolCalls(turn, timeoutMs, () => {
			this.log(`The host did not pick up the tool call(s) of ${key} within ${Math.round(timeoutMs / 1000)}s; ending the turn.`, 'warn');
			failPendingToolCalls(turn, new Error("The chat stopped waiting for this tool call."));
			this.host.agentOf(session).cancel(session.acp.sessionId);
			if (session.turn === turn) {
				session.turn = undefined;
			}
			disposeCancellations(turn);
		});
	}

	/** Stops a turn that a new request replaced, so the agent is not left waiting. */
	async abort(session: ChatSession): Promise<void> {
		const turn = session.turn;
		if (!turn) {
			return;
		}
		session.turn = undefined;
		clearToolDeadline(turn);
		disposeCancellations(turn);
		failPendingToolCalls(turn, new Error(CANCELLED_TOOL_CALL));
		this.host.agentOf(session).cancel(session.acp.sessionId);
		await Promise.race([turn.prompt.then(() => undefined, () => undefined), delay(ABANDONED_TURN_WAIT_MS)]);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}
