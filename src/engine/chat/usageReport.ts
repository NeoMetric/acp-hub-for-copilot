/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AcpTokenUsage } from '../acp/protocol';
import { hitRateOf, sameInput } from './cache';
import type { Log } from '../ports/host';
import type { ActiveTurn, ChatSession } from './types';

export const CHARS_PER_TOKEN = 4;

function describeUsage(usage: AcpTokenUsage): string {
	return `${usage.cachedReadTokens} cached, ${usage.inputTokens} fresh, ${usage.cachedWriteTokens} written`;
}

/** Adds the usage of one model call to the running total of a turn. */
export function addModelCall(turn: ActiveTurn, call: AcpTokenUsage): AcpTokenUsage {
	const sum = turn.requestUsage;
	const total: AcpTokenUsage = {
		inputTokens: (sum?.inputTokens ?? 0) + call.inputTokens,
		outputTokens: (sum?.outputTokens ?? 0) + call.outputTokens,
		cachedReadTokens: (sum?.cachedReadTokens ?? 0) + call.cachedReadTokens,
		cachedWriteTokens: (sum?.cachedWriteTokens ?? 0) + call.cachedWriteTokens,
		totalTokens: (sum?.totalTokens ?? 0) + call.totalTokens,
	};
	turn.requestUsage = total;
	return total;
}

/**
 * The first model call (or turn) after a session was resumed or forked shows
 * whether the prompt cache still served the conversation; say so once.
 */
export function logReuseVerdict(session: ChatSession, usage: AcpTokenUsage, unit: 'model call' | 'turn', log: Log): void {
	if (!session.reused || session.reused.logged) {
		return;
	}
	session.reused.logged = true;
	const total = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
	const verdict = usage.cachedReadTokens > 0 && usage.cachedReadTokens >= total / 2 ? 'the cache served the conversation' : 'the conversation was mostly NOT served from the cache';
	log(`[reuse] First ${unit} after the session was ${session.reused.how} from ${session.reused.from}: ${verdict} (${describeUsage(usage)} of ${total}).`);
}

/**
 * Logs the cache split of a model call, or of a whole turn for agents that only report the turn.
 * A turn figure is the sum over every model call of the turn, each of which sends the whole context
 * again, so `calls` (when known) says how many calls it adds up.
 */
export function logCache(label: 'Model call' | 'Turn cache', usage: AcpTokenUsage, log: Log, calls = 0): void {
	const sum = label === 'Turn cache' && calls > 0 ? `, summed over ${calls} model call(s)` : '';
	log(`${label}: ${hitRateOf(usage).toFixed(1)}% hit (${describeUsage(usage)}${sum}).`);
}

/** Logs the tokens of a turn for an agent whose cache counts mean nothing, so no hit rate is shown. */
export function logTokens(usage: AcpTokenUsage, log: Log): void {
	const thinking = usage.reasoningOutputTokens ? `, ${usage.reasoningOutputTokens} of thinking` : '';
	log(`Turn tokens: ${usage.inputTokens} in, ${usage.outputTokens} out${thinking}.`);
}

/**
 * Logs one model call of an agent that reports only the context it sent (`usage_update`) and the cache
 * split of the whole turn, so the turn's total can be traced to the calls that make it up.
 */
export function logContextCall(turn: ActiveTurn, used: number, size: number | undefined, log: Log): void {
	turn.contextCalls++;
	turn.contextSent += used;
	log(`Model call #${turn.contextCalls}: ${used} token(s) in context${size ? ` of ${size}` : ''}; ${turn.contextSent} token(s) sent so far this turn.`);
}

/** Warns when the model calls of a turn do not add up to the turn's own figure. */
export function warnIfCallsMissing(calls: AcpTokenUsage | undefined, reported: AcpTokenUsage | undefined, log: Log): void {
	if (calls && reported && !sameInput(calls, reported)) {
		log(`The model calls of the turn add up to ${describeUsage(calls)}, but the agent reports ${describeUsage(reported)} for the turn; the cache figures may leave out calls.`, 'warn');
	}
}

/**
 * Reports what the turn spent since the previous report.
 *
 * Copilot reads token usage from the `usage` data part, and both the chat
 * context indicator and the Agents window session info are built on it. Each
 * response is one request to Copilot, and the indicator shows that request's
 * prompt as the size of the context, so the prompt count must be the whole
 * context the agent holds, not what the turn added. The agent's own
 * `usage_update` carries that size; the per-turn counters only cover tokens
 * that were not served from the cache and would understate it.
 */
export function reportUsage(turn: ActiveTurn, log: Log): void {
	const usage = turn.result?.usage;
	const completionTokens = usage
		? Math.max(0, usage.outputTokens - turn.reportedTokens)
		: Math.max(0, Math.ceil(turn.characters / CHARS_PER_TOKEN) - turn.reportedTokens);

	let promptTokens: number;
	if (turn.contextUsed !== undefined) {
		promptTokens = Math.max(0, turn.contextUsed - completionTokens);
	} else if (turn.lastCall) {
		// The agent reports only the sums of the turn, which add up every call; the last call sent
		// what the agent holds now, and its figure already leaves out what it answered.
		promptTokens = turn.lastCall.promptTokens;
	} else if (usage) {
		promptTokens = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
	} else {
		promptTokens = 0;
	}

	if (promptTokens === 0 && completionTokens === 0) {
		return;
	}

	turn.reportedTokens += completionTokens;

	turn.sink({
		type: 'usage',
		promptTokens,
		cachedTokens: turn.contextUsed !== undefined ? usage?.cachedReadTokens ?? 0 : turn.lastCall?.cachedTokens ?? usage?.cachedReadTokens ?? 0,
		outputTokens: completionTokens,
		reasoningTokens: usage?.reasoningOutputTokens ?? 0,
	});
	log(`Reported usage: ${promptTokens} prompt token(s), ${completionTokens} completion token(s)`, 'debug');
}
