/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { fingerprint, isSystemMessage, textOf } from '../convert';
import { conversationIdOf, resolveCwd, systemGuidanceOf, workspaceFoldersOf } from '../requestContext';
import { RpcConnectionClosedError } from '../rpc';
import { shortHash } from '../sessionStore';
import type { ChatContext, GuidanceChange } from './types';

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
 * Whether Copilot now offers a different set of tools than the session opened
 * with. The agent lists its tools once, when it opens, so a tool added or removed
 * later only reaches it through a new session.
 */
export function toolsDiffer(opened: ReadonlySet<string>, tools: readonly vscode.LanguageModelChatTool[]): boolean {
	return tools.length !== opened.size || tools.some(tool => !opened.has(tool.name));
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
export function guidanceChangeOf(savedLines: readonly string[] | undefined, guidance: string | undefined): GuidanceChange {
	const current = guidanceLines(guidance);
	const before = new Set(savedLines);
	const now = new Set(current.map(line => line.hash));
	return {
		added: current.filter(line => !before.has(line.hash)).map(line => line.text),
		removed: savedLines ? savedLines.filter(hash => !now.has(hash)).length : 0,
	};
}

function squashGuidance(text: string | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim().replace(/\\/g, '/').toLowerCase().replace(/(session-state\/)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '$1<chat>');
}

function workspaceOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	const windowFolder = vscode.workspace.workspaceFolders?.[0];
	return workspaceFoldersOf(messages)?.[0] ?? (windowFolder ? windowFolder.uri.toString() : 'no-workspace');
}

/**
 * Copilot gives a provider no identifier for the chat a request belongs to, so
 * a chat is identified by the workspace plus its opening messages, which never
 * change as the conversation grows. Chats running at once then keep separate
 * ACP sessions and cannot receive each other's output or tool results.
 *
 * The workspace is the one Copilot rendered into the chat, since a window can
 * show chats of other folders. Copilot's conversation id keeps chats that open
 * with the same words apart; sub-agents of a chat share it but open
 * differently, so they still get sessions of their own.
 */
export function sessionKey(messages: readonly vscode.LanguageModelChatRequestMessage[], options?: vscode.ProvideLanguageModelChatResponseOptions): string {
	const workspace = workspaceOf(messages);
	const conversation = conversationIdOf(options) ?? '';
	// The system prompt is left out: the host renders it afresh for each request. The opening is every
	// message before the first reply, since a fixed count would grow from one message to two when
	// the first tool call is answered, and the chat would move to a new session in the middle of its turn.
	const chatMessages = messages.filter(message => !isSystemMessage(message));
	const firstReply = chatMessages.findIndex(message => message.role === vscode.LanguageModelChatMessageRole.Assistant);
	const opening = (firstReply < 0 ? chatMessages : chatMessages.slice(0, Math.max(firstReply, 1))).map(fingerprint).join('\n');
	return `${workspace}#${conversation}#${createHash('sha1').update(opening).digest('hex').slice(0, 12)}`;
}

/**
 * Identifies a chat for per-chat figures. Unlike the session key it rests on the
 * first message alone, so the id stays the same when the agent session is
 * replaced and one chat is never listed twice.
 */
export function chatIdOf(messages: readonly vscode.LanguageModelChatRequestMessage[], options?: vscode.ProvideLanguageModelChatResponseOptions): string {
	const first = messages.find(message => !isSystemMessage(message));
	return createHash('sha1').update(`${workspaceOf(messages)}#${conversationIdOf(options) ?? ''}#${first ? fingerprint(first) : ''}`).digest('hex').slice(0, 12);
}

/** The opening words of a chat, without the context blocks Copilot wraps around them. */
export function chatLabelOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	const first = messages.find(message => !isSystemMessage(message) && message.role === vscode.LanguageModelChatMessageRole.User);
	const text = first ? textOf(first).replace(/<(\w+)>[\s\S]*?<\/\1>/g, ' ').replace(/\s+/g, ' ').trim() : '';
	if (!text) {
		return 'Chat';
	}
	return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** The workspace of the chat a request belongs to; `windowCwd` is where the window's folder is. */
export function chatContextOf(messages: readonly vscode.LanguageModelChatRequestMessage[], windowCwd: string): ChatContext {
	const folders = workspaceFoldersOf(messages);
	return { folders, cwd: resolveCwd(folders, windowCwd), guidance: systemGuidanceOf(messages) };
}
