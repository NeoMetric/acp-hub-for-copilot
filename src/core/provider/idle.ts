/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSettings } from '../adapter';

/** Chat sessions kept alive at once; the least recently used idle one is closed beyond this. */
export const MAX_CHAT_SESSIONS = 8;

/**
 * A chat that is not being used gives its agent session back after this long.
 * The conversation stays on disk and the next message resumes it. Settable;
 * 0 keeps sessions until evicted.
 */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 120;
/** How long the session that reads the models lives after its last use. */
export const WARM_SESSION_IDLE_MS = 30_000;
export const IDLE_SWEEP_MS = 15_000;
/**
 * With no chat session left, the agent process itself is stopped after this long,
 * which also takes down the helper processes it started per session. The next
 * request starts it again. Settable; 0 keeps the agent for the whole window.
 */
export const DEFAULT_AGENT_IDLE_MINUTES = 30;

function numberOr(settings: AgentSettings | undefined, key: string, fallback: number): number {
	const value = settings?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/** How long a chat session may sit unused before it is released; 0 means never. */
export function idleTimeoutMs(settings: AgentSettings | undefined): number {
	return numberOr(settings, 'idleTimeoutSeconds', DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
}

/** How long the agent process may sit unused before it is stopped; 0 means never. */
export function agentIdleMs(settings: AgentSettings | undefined): number {
	return numberOr(settings, 'idleShutdownMinutes', DEFAULT_AGENT_IDLE_MINUTES) * 60_000;
}
