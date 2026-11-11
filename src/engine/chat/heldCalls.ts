/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolResult } from '../model/chat';
import type { Log } from '../ports/host';
import { skillContextAfterReply } from './messages';
import type { ActiveTurn } from './types';
import type { ChatMessage } from '../model/chat';

/** What the host itself tells the model when a tool call did not run. */
export const CANCELLED_TOOL_CALL = "The user cancelled the tool call.";

export function wakeTurn(turn: ActiveTurn): void {
	const waiters = turn.waiters;
	turn.waiters = [];
	for (const wake of waiters) {
		wake();
	}
}

export function sleepUntilActivity(turn: ActiveTurn): Promise<void> {
	return new Promise<void>(resolve => turn.waiters.push(resolve));
}

export function failPendingToolCalls(turn: ActiveTurn, error: Error): void {
	for (const pending of [...turn.pending.values(), ...turn.held]) {
		pending.reject(error);
	}
	turn.pending.clear();
	turn.held.length = 0;
}

/**
 * Hands a tool call the agent made to the caller of the current request.
 *
 * Resolves with `undefined` when no response is open that could carry the
 * call, so the bridge runs the tool itself.
 */
export function handOverToolCall(turn: ActiveTurn | undefined, callId: string, name: string, input: unknown, signal: AbortSignal, log: Log): Promise<ToolResult | undefined> {
	if (!turn || turn.finished) {
		log(`Tool ${name} was requested without a turn (${turn ? 'finished' : 'none'}); refusing it.`, 'warn');
		return Promise.resolve(undefined);
	}

	const toolInput = (input ?? {}) as object;
	return new Promise<ToolResult>((resolve, reject) => {
		const onAbort = (): void => {
			turn.pending.delete(callId);
			const index = turn.held.findIndex(call => call.callId === callId);
			if (index >= 0) {
				turn.held.splice(index, 1);
			}
			reject(new Error(CANCELLED_TOOL_CALL));
		};
		const settle = {
			resolve: (content: readonly ToolResult['content'][number][], isError: boolean) => {
				signal.removeEventListener('abort', onAbort);
				resolve({ content, isError });
			},
			reject: (error: Error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		};
		if (signal.aborted) {
			reject(new Error(CANCELLED_TOOL_CALL));
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		if (!turn.streaming) {
			// The host is still running an earlier call, so no response is open. The
			// next response, which carries that call's result, carries this one too.
			log(`Tool ${name} was requested while the host runs an earlier call (${turn.pending.size} pending, ${turn.held.length} held); holding it for the next response.`);
			turn.held.push({ ...settle, callId, name, input: toolInput });
			return;
		}
		turn.pending.set(callId, settle);
		turn.sink({ type: 'tool-call', callId, name, input: toolInput });
		wakeTurn(turn);
	});
}

/** Puts the calls held between two responses into the response that just opened. */
export function releaseHeldToolCalls(turn: ActiveTurn, log: Log): void {
	const held = turn.held.splice(0);
	for (const call of held) {
		turn.pending.set(call.callId, { resolve: call.resolve, reject: call.reject });
		turn.sink({ type: 'tool-call', callId: call.callId, name: call.name, input: call.input });
	}
	if (held.length > 0) {
		log(`Returned ${held.length} held tool call(s) to the host.`);
	}
}

/** Settles pending tool calls with the results the host just returned. */
export function resolveToolResults(turn: ActiveTurn, messages: readonly ChatMessage[], log: Log): boolean {
	let resolved = 0;
	const skillContext = skillContextAfterReply(messages);

	// A background-command notification can add an assistant message after a
	// pending result. Only matching call IDs can settle the current calls.
	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		for (const part of message.parts) {
			if (part.type !== 'tool-result') {
				continue;
			}
			const pending = turn.pending.get(part.callId);
			if (!pending) {
				continue;
			}
			turn.pending.delete(part.callId);
			let content: readonly ToolResult['content'][number][] = part.content;
			if (skillContext?.callId === part.callId) {
				const included = content.some(item => item.type === 'text' && item.text.includes(skillContext.text));
				if (!included) {
					content = [...content, { type: 'text', text: skillContext.text }];
				}
				log(`Skill context (${skillContext.text.length} characters) ${included ? 'already present in' : 'appended to'} tool result.`, 'debug');
			}
			pending.resolve(content, part.isError === true);
			resolved++;
		}
	}

	if (resolved > 0) {
		turn.streaming = true;
		log(`Received ${resolved} tool result(s) for the pending turn.`);
	}
	return resolved > 0;
}

/** Keeps a turn stoppable after its response returned to have the host run its tools. */
export function trackCancellation(turn: ActiveTurn, signal: AbortSignal, cancelAgent: () => void, log: Log): void {
	if (turn.finished) {
		return;
	}
	const onAbort = (): void => {
		log(`Cancelling the turn of ACP session ${turn.sessionId}`);
		failPendingToolCalls(turn, new Error("The request was cancelled."));
		cancelAgent();
	};
	if (signal.aborted) {
		onAbort();
		return;
	}
	signal.addEventListener('abort', onAbort, { once: true });
	turn.cancellations.push(() => signal.removeEventListener('abort', onAbort));
}

export function disposeCancellations(turn: ActiveTurn): void {
	for (const dispose of turn.cancellations) {
		dispose();
	}
	turn.cancellations.length = 0;
}

/**
 * The host can stop waiting for a tool call it was handed, for example when its
 * chat is closed, and nothing else would ever settle the call. Failing it here
 * beats the agent's own timeout, which costs it a whole step.
 */
export function watchToolCalls(turn: ActiveTurn, timeoutMs: number, onTimeout: () => void): void {
	clearToolDeadline(turn);
	turn.toolDeadline = setTimeout(() => {
		turn.toolDeadline = undefined;
		if (turn.finished || turn.streaming || turn.pending.size === 0) {
			return;
		}
		onTimeout();
	}, timeoutMs);
	turn.toolDeadline.unref();
}

export function clearToolDeadline(turn: ActiveTurn): void {
	clearTimeout(turn.toolDeadline);
	turn.toolDeadline = undefined;
}
