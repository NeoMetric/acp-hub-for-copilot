/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { fingerprint, isSystemMessage, textOf } from '../convert';
import { conversationIdOf, resolveCwd, systemGuidanceOf, workspaceFoldersOf } from '../requestContext';
import type { ChatContext } from './types';

/** The guidance helpers live in the engine now; every existing import site keeps working. */
export { MAX_TURN_FAILURES, keepsSessionAfterFailure, guidanceDiffers, guidanceHashOf, guidanceLineHashes, guidanceChangeOf, mergeGuidanceChange, toolChangeOf, describeToolChange } from '../../engine/chat/keys';

/**
 * Whether the host now offers a different set of tools than the session has.
 * An agent that does not refresh its tool list on `tools/list_changed` reads it
 * once, when its session opens, so such a change only reaches it by reopening the session.
 */
export function toolsDiffer(opened: ReadonlySet<string>, tools: readonly vscode.LanguageModelChatTool[]): boolean {
	return tools.length !== opened.size || tools.some(tool => !opened.has(tool.name));
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

