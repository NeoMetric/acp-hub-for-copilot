/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentAdapter } from '../adapter';
import type { AcpSessionUpdate, AcpTokenUsage } from '../agentClient';
import type { RequestMeasurement } from '../cache';
import type { AcpContentBlock } from '../convert';
import type { Log } from '../logging';
import { RpcConnectionClosedError } from '../rpc';
import type { SavedSessionStore } from '../sessionStore';
import { CANCELLED_TOOL_CALL, clearToolDeadline, disposeCancellations, failPendingToolCalls, releaseHeldToolCalls, sleepUntilActivity, trackCancellation, wakeTurn, watchToolCalls } from './heldCalls';
import { keepsSessionAfterFailure } from './keys';
import type { ModelList } from './modelList';
import { rememberSession } from './reuse';
import { describe } from './sessionOptions';
import type { ActiveTurn, AgentApi, ChatSession, FinishedTurn } from './types';
import { addModelCall, logCache, logReuseVerdict, reportUsage, warnIfCallsMissing } from './usageReport';

/**
 * How long to collect tool calls before handing a turn back to Copilot, so
 * calls the agent issued in parallel travel in the same response.
 */
const PARALLEL_TOOL_WINDOW_MS = 250;
/** How long to wait for an abandoned turn to end before moving on. */
const ABANDONED_TURN_WAIT_MS = 5_000;

/** What the turns need from the provider that owns them. */
export interface TurnHost {
	adapter: AgentAdapter;
	log: Log;
	models: ModelList;
	saved: SavedSessionStore;
	agent(): AgentApi;
	finished(turn: FinishedTurn): void;
	measured(measurement: RequestMeasurement): void;
	destroySession(key: string): Promise<void>;
	isSignInRequired(error: unknown): boolean;
	promptSignIn(): void;
	needsCredentials(): string;
}

export class TurnRunner {

	constructor(private readonly host: TurnHost) { }

	private get log(): Log {
		return this.host.log;
	}

	private get agent(): AgentApi {
		return this.host.agent();
	}

	/** Whether the agent reports the usage of each model call, not only of the turn. */
	private get reportsEachModelCall(): boolean {
		return this.host.adapter.modelCallUsage !== undefined;
	}

	start(session: ChatSession, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, blocks: readonly AcpContentBlock[]): ActiveTurn {
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

		const prompt = this.agent.prompt(session.acp.sessionId, blocks, {
			onText: text => {
				firstOutput('text');
				turn.characters += text.length;
				if (turn.streaming) {
					turn.progress.report(new vscode.LanguageModelTextPart(text));
				}
			},
			onThought: text => {
				firstOutput('thinking');
				if (turn.streaming) {
					reportThinking(turn.progress, text);
				}
			},
			onUpdate: (update: AcpSessionUpdate) => {
				if (update.sessionUpdate === 'tool_call') {
					firstOutput('tool call');
				}
				this.handleUpdate(session, turn, update);
			},
			onUsage: this.reportsEachModelCall ? usage => this.measureRequest(session, turn, usage) : undefined,
			token,
		}).then(
			result => {
				turn.result = result;
				if (result.usage && !this.reportsEachModelCall) {
					logCache('Turn cache', result.usage, this.log);
					logReuseVerdict(session, result.usage, 'turn', this.log);
				}
				return result;
			},
			error => {
				turn.error = error;
				throw error;
			},
		).finally(() => {
			turn.finished = true;
			wakeTurn(turn);
		});

		turn = {
			progress,
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
			reportedTokens: 0,
			contextUsed: session.contextUsed,
			startedAt: Date.now(),
		};

		// The turn can outlive this request; its failure is reported by the request
		// that continues it, so it must not surface as an unhandled rejection.
		void prompt.catch(() => undefined);
		return turn;
	}

	private handleUpdate(session: ChatSession, turn: ActiveTurn, update: AcpSessionUpdate): void {
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
		}
		if (typeof update.size === 'number' && update.size !== turn.contextSize) {
			turn.contextSize = update.size;
			if (this.host.adapter.modelPolicy.refineWindowFromUsage) {
				this.host.models.refineWindow(session.model, update.size);
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
	async drive(key: string, session: ChatSession, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, fingerprints: readonly string[], lastUser: number): Promise<void> {
		const turn = session.turn;
		if (!turn) {
			return;
		}
		turn.progress = progress;
		turn.streaming = true;
		clearToolDeadline(turn);
		releaseHeldToolCalls(turn, this.log);
		trackCancellation(turn, token, () => this.agent.cancel(session.acp.sessionId), this.log);

		try {
			while (!turn.finished) {
				if (turn.pending.size > 0) {
					// Give the agent a moment to issue parallel calls so all of them can
					// travel in this response.
					await delay(PARALLEL_TOOL_WINDOW_MS);
					reportUsage(turn, this.log);
					turn.streaming = false;
					this.watchTools(key, session, turn);
					this.log(`Turn for ${key} asked for ${turn.pending.size} tool call(s); returning them to Copilot.`);
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
			await this.failTurn(key, session, turn, token, fingerprints, lastUser);
			return;
		}

		session.history.length = 0;
		session.history.push(...fingerprints);
		session.failures = 0;
		rememberSession(this.host.saved, key, session, fingerprints, this.log);

		reportUsage(turn, this.log);
		const reported = turn.result?.usage;
		if (this.reportsEachModelCall) {
			warnIfCallsMissing(turn.requestUsage, reported, this.log);
		}
		this.host.finished({ usage: reported, background: session.toolCount === 0, chat: session.chat, model: session.model, contextUsed: turn.contextUsed, contextSize: turn.contextSize });

		const stopReason = turn.result?.stopReason ?? 'unknown';
		this.log(`Turn finished in ${Date.now() - turn.startedAt}ms: ${turn.characters} character(s), ${turn.toolCalls} tool call(s), stop reason "${stopReason}".`);
		if (stopReason === 'cancelled' && !token.isCancellationRequested) {
			this.log('The agent cancelled the turn on its own.', 'warn');
		}
	}

	/** Settles a failed turn: keeps or replaces the session, then fails the request with a readable message. */
	private async failTurn(key: string, session: ChatSession, turn: ActiveTurn, token: vscode.CancellationToken, fingerprints: readonly string[], lastUser: number): Promise<void> {
		const name = this.host.adapter.displayName;
		this.log(`Turn failed after ${Date.now() - turn.startedAt}ms: ${describe(turn.error)}`, 'error');

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
			throw new vscode.LanguageModelError(this.host.needsCredentials());
		}
		if (turn.error instanceof RpcConnectionClosedError) {
			throw new vscode.LanguageModelError(`The ${name} agent stopped. Send your message again to start a new session; if it keeps happening, restart the agent from the ACP Hub sidebar.`);
		}
		if (token.isCancellationRequested) {
			return;
		}
		throw new vscode.LanguageModelError(`${name} failed: ${describe(turn.error)}`);
	}

	/** After the response handed tools over, fails them if Copilot never comes back before the agent's own timeout. */
	private watchTools(key: string, session: ChatSession, turn: ActiveTurn): void {
		const timeoutMs = this.host.adapter.toolWaitTimeoutMs;
		if (timeoutMs === undefined) {
			return;
		}
		watchToolCalls(turn, timeoutMs, () => {
			this.log(`Copilot did not pick up the tool call(s) of ${key} within ${Math.round(timeoutMs / 1000)}s; ending the turn.`, 'warn');
			failPendingToolCalls(turn, new Error("The chat stopped waiting for this tool call."));
			this.agent.cancel(session.acp.sessionId);
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
		this.agent.cancel(session.acp.sessionId);
		await Promise.race([turn.prompt.then(() => undefined, () => undefined), delay(ABANDONED_TURN_WAIT_MS)]);
	}
}

/** Reports a thinking chunk when the running VS Code exposes thinking parts. */
function reportThinking(progress: vscode.Progress<vscode.LanguageModelResponsePart>, text: string): void {
	const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => unknown }).LanguageModelThinkingPart;
	if (ThinkingPart) {
		progress.report(new ThinkingPart(text) as vscode.LanguageModelResponsePart);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}
