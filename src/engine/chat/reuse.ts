/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Log } from '../ports/host';
import type { ToolDef } from '../model/chat';
import { findCheckpoint, findForkSource, hashAll, isPrefixOf, mismatchOf, SAVED_SESSION_VERSION, shortHash, toolsHashOf, type ReuseCheck, type SavedSession, type SavedSessionStore } from './sessionStore';
import { describeToolChange, guidanceChangeOf, guidanceHashOf, guidanceLineHashes, toolChangeOf } from './keys';
import type { ChatContext, ChatSession, Reuse } from './types';

/**
 * Looks for a stored conversation that the request continues: this chat's own
 * after a window reload, or (for agents that can fork) the one a forked chat
 * was copied from. Every step is logged under "[reuse]" so a reload or a fork
 * can be checked in the output.
 */
export function findReusable(saved: SavedSessionStore, key: string, fingerprints: readonly string[], lastUser: number, tools: readonly ToolDef[], context: ChatContext, canFork: boolean, log: Log): Reuse | undefined {
	const check: ReuseCheck = { cwd: context.cwd, toolsHash: toolsHashOf(tools.map(tool => tool.name)), guidanceHash: guidanceHashOf(context.guidance) };
	const incoming = hashAll(fingerprints);
	const all = saved.all();
	log(`[reuse] No live session for ${key}: ${fingerprints.length} message(s), last user message at ${lastUser}, ${all.length} saved session(s), tools ${check.toolsHash}, guidance ${check.guidanceHash}.`, 'debug');

	const own = all.find(entry => entry.key === key);
	if (own) {
		const reason = mismatchOf(own, check, { ignoreGuidance: true, ignoreTools: true }) ?? (isPrefixOf(own.history, incoming) ? undefined : `the chat no longer starts with the ${own.history.length} saved message(s)`);
		if (!reason) {
			log(`[reuse] Saved session ${own.sessionId} matches this chat (${own.history.length} message(s) already in it); resuming it.`, 'debug');
			if (own.toolsHash !== check.toolsHash) {
				const change = own.toolNames ? ` ${describeToolChange(toolChangeOf(own.toolNames, tools.map(tool => tool.name)))}.` : '';
				log(`[reuse] The offered tools differ from the saved ones (${own.toolsHash} -> ${check.toolsHash}); the resumed session gets the current set.${change}`, 'warn');
			}
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
		const first = own.history.findIndex((hash, index) => hash !== incoming[index]);
		if (first >= 0 && first < incoming.length) {
			log(`[reuse] First differing message is #${first} of ${incoming.length}: saved hash ${own.history[first]}, now ${incoming[first]}, text now: ${fingerprints[first].replace(/\s+/g, ' ')}`, 'warn');
		}
	} else {
		log(canFork ? '[reuse] Nothing saved under this key; looking for a session this chat was forked from.' : '[reuse] Nothing saved under this key.', 'debug');
		logGuidanceAgainstLatest(all, check.cwd, context.guidance, log);
	}

	if (!canFork) {
		log('[reuse] Nothing to continue; starting a new session and restoring the chat as a transcript.', 'debug');
		return undefined;
	}

	// A chat that has a session of its own can only have been edited; any other may be a copy of another chat.
	const others = all.filter(entry => entry.key !== key);
	const fork = forkReuse(own ? [own] : others, fingerprints, incoming, lastUser, check, context, log);
	if (fork) {
		return fork;
	}
	// A session saved before checkpoints existed can only be forked at its end.
	const source = own ? undefined : findForkSource(others.filter(entry => (entry.checkpoints?.length ?? 0) === 0), incoming, lastUser, check);
	if (source) {
		log(`[reuse] This chat continues saved session ${source.sessionId} (${source.history.length} message(s), no checkpoints); forking it at its end.`);
		return { kind: 'fork', saved: source, history: fingerprints.slice(0, source.history.length) };
	}
	log(`[reuse] No saved session to continue (${own ? 'the chat\'s own session' : `${others.length} other candidate(s)`} checked); starting a new session and restoring the chat as a transcript.`, 'debug');
	return undefined;
}

/**
 * For a chat whose live session no longer fits its messages (an earlier message was edited):
 * the checkpoint of the chat's own saved session to fork from, if any. Logged under "[reuse]".
 */
export function findEditFork(saved: SavedSessionStore, key: string, fingerprints: readonly string[], lastUser: number, context: ChatContext, log: Log): Reuse | undefined {
	const check: ReuseCheck = { cwd: context.cwd, toolsHash: '', guidanceHash: guidanceHashOf(context.guidance) };
	const own = saved.find(key);
	if (!own) {
		log(`[reuse] The messages of ${key} changed but no session is saved under it; nothing to fork.`, 'debug');
		return undefined;
	}
	return forkReuse([own], fingerprints, hashAll(fingerprints), lastUser, check, context, log);
}

/** The fork from the deepest checkpoint of `candidates` that the request starts with, with every candidate logged. */
function forkReuse(candidates: readonly SavedSession[], fingerprints: readonly string[], incoming: readonly string[], lastUser: number, check: ReuseCheck, context: ChatContext, log: Log): Reuse | undefined {
	for (const entry of candidates) {
		const reason = mismatchOf(entry, check, { ignoreGuidance: true, ignoreTools: true }) ?? ((entry.checkpoints?.length ?? 0) === 0 ? 'it has no checkpoints' : undefined);
		log(`[reuse] Fork candidate ${entry.sessionId} (${entry.history.length} message(s), ${entry.checkpoints?.length ?? 0} checkpoint(s) at ${entry.checkpoints?.map(checkpoint => checkpoint.messages).join(', ') || 'none'}): ${reason ?? 'in this folder'}.`, 'debug');
	}
	const match = findCheckpoint(candidates, incoming, lastUser, check);
	if (!match) {
		log(`[reuse] No checkpoint is the start of this request (${incoming.length} message(s), the newest user message at ${lastUser}).`, 'debug');
		return undefined;
	}
	const { saved: source, checkpoint } = match;
	log(`[reuse] Deepest checkpoint: after ${checkpoint.messages} of the ${incoming.length} message(s), agent message ${checkpoint.messageId} (occurrence ${checkpoint.occurrence}) of saved session ${source.sessionId}; forking there.`);
	const history = fingerprints.slice(0, checkpoint.messages);
	if (source.guidanceHash === check.guidanceHash) {
		return { kind: 'fork', saved: source, checkpoint, history };
	}
	const guidanceChange = guidanceChangeOf(source.guidanceLines, context.guidance);
	log(`[reuse] The workspace guidance differs from the saved one (${source.guidanceHash} -> ${check.guidanceHash}): ${guidanceChange.added.length} line(s) new, ${guidanceChange.removed} gone. Forking anyway and sending the change.`, 'warn');
	return { kind: 'fork', saved: source, checkpoint, history, guidanceChange };
}

/** Logs how this chat's guidance differs from the latest saved session in the same folder, to show what Copilot changed. */
function logGuidanceAgainstLatest(all: readonly SavedSession[], cwd: string, guidance: string | undefined, log: Log): void {
	const latest = all.filter(entry => entry.cwd === cwd).sort((a, b) => b.savedAt - a.savedAt)[0];
	if (!latest) {
		return;
	}
	const change = guidanceChangeOf(latest.guidanceLines, guidance);
	log(`[reuse] Guidance against latest saved session ${latest.sessionId} (${latest.guidanceHash} -> ${guidanceHashOf(guidance)}): ${change.added.length} line(s) new, ${change.removed} gone.`, 'debug');
}

/** Remembers where the conversation of a chat is stored, so a later window or a fork can continue it. */
export function rememberSession(saved: SavedSessionStore, key: string, session: ChatSession, fingerprints: readonly string[], log: Log): void {
	if (!session.hasPrompt) {
		return;
	}
	saved.save({
		version: SAVED_SESSION_VERSION,
		key,
		sessionId: session.acp.sessionId,
		cwd: session.context.cwd,
		history: hashAll(fingerprints),
		toolsHash: session.toolsHash,
		toolNames: [...session.openedTools].sort(),
		guidanceHash: session.guidanceHash,
		promptHash: session.promptHash,
		guidanceLines: guidanceLineHashes(session.context.guidance),
		checkpoints: [...session.checkpoints],
		forked: session.forked,
		savedAt: Date.now(),
	});
	log(`[reuse] Saved session ${session.acp.sessionId} for ${key}: ${fingerprints.length} message(s), ${session.checkpoints.length} checkpoint(s).`, 'debug');
}

export function promptHashOf(systemPromptAppend: string | undefined): string {
	return shortHash(systemPromptAppend ?? '');
}
