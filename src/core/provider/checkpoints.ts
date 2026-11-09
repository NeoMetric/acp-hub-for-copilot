/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AcpSessionUpdate } from '../../engine/acp/agentClient';
import { messageFingerprintOf, type Checkpoint } from '../sessionStore';

/** One message the agent said during a turn, put together from its chunks. */
export interface AgentMessage {
	readonly id: string | undefined;
	text: string;
	/** Set once a tool call came after the message, so a later chunk starts another one. */
	closed: boolean;
}

/** Adds what an update says to the messages of the turn: the text of a chunk to its message, a tool call as the end of one. */
export function noteAgentUpdate(messages: AgentMessage[], update: AcpSessionUpdate): void {
	const last = messages.at(-1);
	if (update.sessionUpdate === 'tool_call') {
		if (last) {
			last.closed = true;
		}
		return;
	}
	const text = update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' ? update.content.text : undefined;
	if (!text) {
		return;
	}
	if (last && !last.closed && last.id === update.messageId) {
		last.text += text;
	} else {
		messages.push({ id: update.messageId, text, closed: false });
	}
}

/**
 * The checkpoint a finished turn adds, or undefined when the turn did not end on a message of
 * the agent's (it ended on a tool call, or said nothing). `counts` holds how often each message
 * text occurs in the session so far and takes in this turn's messages; `covered` is how many
 * Copilot messages the session holds once the turn's reply is counted.
 */
export function checkpointOf(messages: readonly AgentMessage[], counts: Map<string, number>, covered: number): Checkpoint | undefined {
	let occurrence = 0;
	let fingerprint = '';
	for (const message of messages) {
		if (message.text.trim().length === 0) {
			continue;
		}
		fingerprint = messageFingerprintOf(message.text);
		occurrence = (counts.get(fingerprint) ?? 0) + 1;
		counts.set(fingerprint, occurrence);
	}
	const last = messages.at(-1);
	if (!last || last.closed || last.text.trim().length === 0) {
		return undefined;
	}
	// An agent that names no message still gets a fork point, which it finds by the fingerprint.
	return { messages: covered, messageId: last.id ?? `acp-hub-${fingerprint.slice(7, 19)}-${occurrence}`, fingerprint, occurrence, messageCounts: Object.fromEntries(counts) };
}

/** Restores the highest known occurrence of each checkpoint's message. */
export function countsOf(checkpoints: readonly Checkpoint[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const checkpoint of checkpoints) {
		for (const [fingerprint, count] of Object.entries(checkpoint.messageCounts ?? {})) {
			if (Number.isSafeInteger(count) && count > 0) {
				counts.set(fingerprint, Math.max(counts.get(fingerprint) ?? 0, count));
			}
		}
		counts.set(checkpoint.fingerprint, Math.max(counts.get(checkpoint.fingerprint) ?? 0, checkpoint.occurrence));
	}
	return counts;
}
