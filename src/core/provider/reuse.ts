/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { Log } from '../logging';
import { findForkSource, hashAll, isPrefixOf, mismatchOf, shortHash, toolsHashOf, type ReuseCheck, type SavedSessionStore } from '../sessionStore';
import { guidanceChangeOf, guidanceHashOf, guidanceLineHashes } from './keys';
import type { ChatContext, ChatSession, Reuse } from './types';

/**
 * Looks for a stored conversation that the request continues: this chat's own
 * after a window reload, or (for agents that can fork) the one a forked chat
 * was copied from. Every step is logged under "[reuse]" so a reload or a fork
 * can be checked in the output.
 */
export function findReusable(saved: SavedSessionStore, key: string, fingerprints: readonly string[], lastUser: number, tools: readonly vscode.LanguageModelChatTool[], context: ChatContext, canFork: boolean, log: Log): Reuse | undefined {
	const check: ReuseCheck = { cwd: context.cwd, toolsHash: toolsHashOf(tools.map(tool => tool.name)), guidanceHash: guidanceHashOf(context.guidance) };
	const incoming = hashAll(fingerprints);
	const all = saved.all();
	log(`[reuse] No live session for ${key}: ${fingerprints.length} message(s), last user message at ${lastUser}, ${all.length} saved session(s), tools ${check.toolsHash}, guidance ${check.guidanceHash}.`);

	const own = all.find(entry => entry.key === key);
	if (own) {
		const reason = mismatchOf(own, check, { ignoreGuidance: true }) ?? (isPrefixOf(own.history, incoming) ? undefined : `the chat no longer starts with the ${own.history.length} saved message(s)`);
		if (!reason) {
			log(`[reuse] Saved session ${own.sessionId} matches this chat (${own.history.length} message(s) already in it); resuming it.`);
			const history = fingerprints.slice(0, own.history.length);
			if (own.guidanceHash === check.guidanceHash) {
				return { kind: 'resume', saved: own, history };
			}
			const guidanceChange = guidanceChangeOf(own.guidanceLines, context.guidance);
			const preview = guidanceChange.added.join(' | ').slice(0, 600);
			log(`[reuse] The workspace guidance differs from the saved one (${own.guidanceHash} -> ${check.guidanceHash}): ${guidanceChange.added.length} line(s) new, ${guidanceChange.removed} gone. Resuming anyway and sending the change. New: ${preview}`, 'warn');
			return { kind: 'resume', saved: own, history, guidanceChange };
		}
		log(`[reuse] Saved session ${own.sessionId} found under this key but not usable: ${reason}.`, 'warn');
	} else {
		log(canFork ? '[reuse] Nothing saved under this key; looking for a session this chat was forked from.' : '[reuse] Nothing saved under this key.');
	}

	if (!canFork) {
		log('[reuse] Nothing to continue; starting a new session and restoring the chat as a transcript.');
		return undefined;
	}

	const others = all.filter(entry => entry.key !== key);
	for (const entry of others) {
		const reason = mismatchOf(entry, check) ?? (entry.history.length > lastUser ? `it holds ${entry.history.length} message(s), more than the ${lastUser} before this request` : isPrefixOf(entry.history, incoming) ? undefined : 'its messages are not the start of this chat');
		log(`[reuse] Fork candidate ${entry.sessionId} (${entry.history.length} message(s)): ${reason ?? 'matches'}.`);
	}
	const source = findForkSource(others, incoming, lastUser, check);
	if (source) {
		log(`[reuse] This chat continues saved session ${source.sessionId} (${source.history.length} message(s)); forking it.`);
		return { kind: 'fork', saved: source, history: fingerprints.slice(0, source.history.length) };
	}
	log(`[reuse] No saved session to continue (${others.length} other candidate(s) checked); starting a new session and restoring the chat as a transcript.`);
	return undefined;
}

/** Remembers where the conversation of a chat is stored, so a later window or a fork can continue it. */
export function rememberSession(saved: SavedSessionStore, key: string, session: ChatSession, fingerprints: readonly string[], log: Log): void {
	if (!session.hasPrompt) {
		return;
	}
	saved.save({
		key,
		sessionId: session.acp.sessionId,
		cwd: session.context.cwd,
		history: hashAll(fingerprints),
		toolsHash: session.toolsHash,
		guidanceHash: session.guidanceHash,
		promptHash: session.promptHash,
		guidanceLines: guidanceLineHashes(session.context.guidance),
		savedAt: Date.now(),
	});
	log(`[reuse] Saved session ${session.acp.sessionId} for ${key}: ${fingerprints.length} message(s).`, 'debug');
}

export function promptHashOf(systemPromptAppend: string | undefined): string {
	return shortHash(systemPromptAppend ?? '');
}
