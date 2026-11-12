/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { shortHash } from './sessionStore';
import { RpcConnectionClosedError } from '../acp/rpc';
import type { GuidanceChange } from './types';
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

/**
 * Whether the guidance describing the chat differs from the one the session was
 * given. Copilot renders its system prompt again for every request, and the
 * agent keeps the one it was opened with: a chat that switches between asking
 * and working, or turns autopilot on, would otherwise keep the old rules.
 *
 * Case and spacing are folded, because a host may write the same prompt with a
 * different drive-letter casing and that is no change to what it says. The id
 * in the host's per-chat session folder is dropped too: it names the chat, so a
 * forked chat would otherwise never match the session it was copied from.
 */
export function guidanceDiffers(before: string | undefined, after: string | undefined): boolean {
	return squashGuidance(before) !== squashGuidance(after);
}

export function guidanceHashOf(guidance: string | undefined): string {
	return shortHash(squashGuidance(guidance));
}

/** A message fingerprint as one short log line: tool output and file contents would otherwise fill the log across many lines. */
export function fingerprintPreview(fingerprint: string | undefined, limit = 200): string {
	const flat = (fingerprint ?? '').replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit)}… (${flat.length} characters)` : flat;
}

/** The line in which Copilot names the mode the chat runs in, and the block that holds its instructions. */
const MODE_LINE = /^You are currently running in "(.+)" mode\./;
const MODE_BLOCK = /<modeInstructions>[\s\S]*?<\/modeInstructions>/g;

/** The distinct non-empty lines of the guidance, each with the hash it is compared by. */
function guidanceLines(guidance: string | undefined): Array<{ text: string; hash: string }> {
	const seen = new Set<string>();
	const lines: Array<{ text: string; hash: string }> = [];
	for (const raw of (guidance ?? '').split(/\r?\n/)) {
		const text = raw.trim();
		const hash = shortHash(squashGuidance(text));
		if (text && !seen.has(hash)) {
			seen.add(hash);
			lines.push({ text, hash });
		}
	}
	return lines;
}

export function guidanceLineHashes(guidance: string | undefined): string[] {
	return guidanceLines(guidance).map(line => line.hash);
}

/**
 * What the guidance gained and lost since a session was saved. A session saved
 * without its line hashes cannot say, so all of the current guidance counts as new.
 */
export function guidanceChangeOf(savedLines: readonly string[] | undefined, guidance: string | undefined, previous?: string): GuidanceChange {
	const current = guidanceLines(guidance);
	const before = new Set(savedLines);
	const now = new Set(current.map(line => line.hash));
	const change = {
		added: current.filter(line => !before.has(line.hash)).map(line => line.text),
		removed: savedLines ? savedLines.filter(hash => !now.has(hash)).length : 0,
	};
	if (previous === undefined) {
		return change;
	}

	// The instructions of a mode that was left are retracted by naming the mode, not by repeating them.
	const gone = guidanceLines(previous).filter(line => !now.has(line.hash));
	const leftMode = gone.map(line => MODE_LINE.exec(line.text)?.[1]).find(name => name !== undefined);
	const modeLines = leftMode === undefined ? new Set<string>() : new Set(guidanceLines([...previous.matchAll(MODE_BLOCK)].map(match => match[0]).join('\n')).map(line => line.hash));
	return {
		...change,
		...(leftMode === undefined ? {} : { leftMode }),
		goneLines: gone.filter(line => !modeLines.has(line.hash)).map(line => line.text),
	};
}

/** Puts a change that has not been sent yet together with the one that follows it. */
export function mergeGuidanceChange(first: GuidanceChange, second: GuidanceChange): GuidanceChange {
	const added = [...new Set([...first.added, ...second.added])];
	const leftMode = second.leftMode ?? first.leftMode;
	const stillInMode = leftMode !== undefined && added.some(line => MODE_LINE.exec(line)?.[1] === leftMode);
	const gone = [...(first.goneLines ?? []), ...(second.goneLines ?? [])].filter(line => !added.includes(line));
	return {
		added,
		removed: first.removed + second.removed,
		...(leftMode === undefined || stillInMode ? {} : { leftMode }),
		...(first.goneLines || second.goneLines ? { goneLines: [...new Set(gone)] } : {}),
	};
}

function squashGuidance(text: string | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim().replace(/\\/g, '/').toLowerCase().replace(/(session-state\/)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '$1<chat>');
}

