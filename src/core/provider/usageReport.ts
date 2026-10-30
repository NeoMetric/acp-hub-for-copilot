/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AcpTokenUsage } from '../agentClient';
import { hitRateOf, sameInput } from '../cache';
import type { Log } from '../logging';
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

/** Logs the cache split of a model call, or of a whole turn for agents that only report the turn. */
export function logCache(label: 'Model call' | 'Turn cache', usage: AcpTokenUsage, log: Log): void {
	log(`${label}: ${hitRateOf(usage).toFixed(1)}% hit (${describeUsage(usage)}).`);
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
	} else if (usage) {
		promptTokens = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
	} else {
		promptTokens = 0;
	}

	if (promptTokens === 0 && completionTokens === 0) {
		return;
	}

	turn.reportedTokens += completionTokens;

	const payload = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
		prompt_tokens_details: { cached_tokens: usage?.cachedReadTokens ?? 0 },
		completion_tokens_details: { reasoning_tokens: usage?.reasoningOutputTokens ?? 0 },
	};
	turn.progress.report(vscode.LanguageModelDataPart.json(payload, 'usage'));
	log(`Reported usage: ${promptTokens} prompt token(s), ${completionTokens} completion token(s)`);
	if (usage) {
		const totalInput = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
		const hitRate = totalInput > 0 ? ((usage.cachedReadTokens / totalInput) * 100).toFixed(1) : '0';
		log(`Cache: ${hitRate}% hit rate (${usage.cachedReadTokens} cached, ${usage.inputTokens} fresh, ${usage.cachedWriteTokens} written)`);
	}
}
