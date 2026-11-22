/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RpcConnectionClosedError } from '../acp/rpc';
import type { ToolDef } from '../model/chat';

/** Failed turns in a row after which a session is replaced, so a broken one cannot trap a chat. */
export const MAX_TURN_FAILURES = 3;

/**
 * Whether the session of a failed turn is still usable, and so is worth keeping:
 * the agent holds the conversation, and the next request reads it from the
 * prompt cache instead of paying for the whole of it again. A connection that
 * is gone, a sign-in that is needed or a session that keeps failing leaves
 * nothing to keep, and the next request starts a new session.
 */
export function keepsSessionAfterFailure(error: unknown, failures: number, signedOut: boolean): boolean {
	return !signedOut && !(error instanceof RpcConnectionClosedError) && failures < MAX_TURN_FAILURES;
}

/**
 * Whether Copilot now offers a different set of tools than the session has.
 * An agent that does not refresh its tool list on `tools/list_changed` reads it
 * once, when its session opens, so such a change only reaches it by reopening the session.
 */
export function toolsDiffer(opened: ReadonlySet<string>, tools: readonly ToolDef[]): boolean {
	return tools.length !== opened.size || tools.some(tool => !opened.has(tool.name));
}

/** The tools that were added and removed between two sets of names, for the log. */
export function toolChangeOf(before: Iterable<string>, after: Iterable<string>): { added: string[]; removed: string[] } {
	const was = new Set(before);
	const now = new Set(after);
	return { added: [...now].filter(name => !was.has(name)).sort(), removed: [...was].filter(name => !now.has(name)).sort() };
}

export function describeToolChange(change: { added: readonly string[]; removed: readonly string[] }): string {
	return `${change.added.length} tool(s) added${change.added.length ? ` (${change.added.join(', ')})` : ''}, ${change.removed.length} removed${change.removed.length ? ` (${change.removed.join(', ')})` : ''}`;
}

/** A message fingerprint as one short log line: tool output and file contents would otherwise fill the log across many lines. */
export function fingerprintPreview(fingerprint: string | undefined, limit = 200): string {
	const flat = (fingerprint ?? '').replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit)}… (${flat.length} characters)` : flat;
}
