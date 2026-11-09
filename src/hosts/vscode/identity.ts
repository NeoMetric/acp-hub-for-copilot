/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { stripIdentity } from '../../core/identityPatterns';
import { textOf as textOfMessage } from '../../engine/chat/messages';
import { fingerprint, isSystemMessage, textOf } from './messageText';
import type { ChatContext } from '../../engine/chat/types';
import type { ChatMessage } from '../../engine/model/chat';

/**
 * What a request says about the chat it belongs to. Copilot gives a provider
 * no chat or workspace identifier, so the only sources are the text of the
 * messages it rendered and the model options it adds.
 *
 * Two hosts have been seen, and they describe the workspace differently:
 * - the Copilot SDK host puts the chat's working directory in the
 *   `<environment_context>` of its system message, and lists the files of the
 *   workspace under a root path in `<workspace_info>`;
 * - Copilot Chat lists the folders of the workspace in `<workspace_info>`.
 *
 * This is the VS Code host's knowledge: no other host renders these blocks, and
 * nothing in `src/engine` may read them.
 */

const WORKSPACE_INFO = /<workspace_info>([\s\S]*?)<\/workspace_info>/;
const FOLDERS_HEADER = 'I am working in a workspace with the following folders:';
const NO_WORKSPACE = 'There is no workspace currently open.';
const ENVIRONMENT_CONTEXT = /<environment_context>([\s\S]*?)<\/environment_context>/;
const WORKING_DIRECTORY = /^\* Current working directory: (.+?)\s*$/m;
/** The first line of the file listing is the root the paths below it are relative to. */
const STRUCTURE_ROOT = /Initial workspace structure \(file names only\):[ \t]*\r?\n```[^\r\n]*\r?\n([^\r\n]+)/;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;
const ESCAPED_DRIVE_PATH = /^[A-Za-z]:\\\\/;

/**
 * An absolute folder in one spelling, or `undefined` for text that is not an
 * absolute path. Hosts disagree about the casing of a drive letter, even
 * between two requests of one chat, so it is written in lower case.
 */
export function normalizeFolder(path: string): string | undefined {
	const trimmed = path.trim();
	if (!ABSOLUTE_PATH.test(trimmed)) {
		return undefined;
	}
	const stripped = trimmed.replace(/[\\/]+$/, '');
	const folder = stripped === '' || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped;
	return folder.replace(/^[A-Z]:/, drive => drive.toLowerCase());
}

/** The working directory the host names in its system message. */
function systemWorkingDirectory(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | undefined {
	for (const message of messages) {
		if (!isSystemMessage(message)) {
			continue;
		}
		const environment = ENVIRONMENT_CONTEXT.exec(textOf(message))?.[1];
		const directory = environment === undefined ? undefined : WORKING_DIRECTORY.exec(environment)?.[1];
		const folder = directory === undefined ? undefined : normalizeFolder(directory);
		if (folder !== undefined) {
			return folder;
		}
	}
	return undefined;
}

/** The root of the file listing the SDK host renders, which writes each backslash of a Windows path twice. */
function structureRoot(block: string): string | undefined {
	const root = STRUCTURE_ROOT.exec(block)?.[1].trim();
	if (root === undefined) {
		return undefined;
	}
	return normalizeFolder(ESCAPED_DRIVE_PATH.test(root) ? root.replace(/\\\\/g, '\\') : root);
}

/**
 * The folders the chat belongs to, in the order of preference:
 * 1. the working directory in the system message of the SDK host, which is the
 *    folder the host itself runs the chat in;
 * 2. the folders Copilot rendered into the first message of the chat, which it
 *    freezes for the rest of the chat;
 * 3. the root of the file listing in that message.
 *
 * An empty list means Copilot says no workspace is open; `undefined` means the
 * request does not describe one.
 */
export function workspaceFoldersOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string[] | undefined {
	const working = systemWorkingDirectory(messages);
	if (working !== undefined) {
		return [working];
	}

	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		const block = WORKSPACE_INFO.exec(textOf(message))?.[1];
		if (block === undefined) {
			continue;
		}
		const header = block.indexOf(FOLDERS_HEADER);
		if (header < 0) {
			if (block.includes(NO_WORKSPACE)) {
				return [];
			}
			const root = structureRoot(block);
			return root === undefined ? undefined : [root];
		}

		const folders: string[] = [];
		for (const line of block.slice(header + FOLDERS_HEADER.length).split(/\r?\n/).slice(1)) {
			if (!line.startsWith('- ')) {
				break;
			}
			const folder = normalizeFolder(line.slice(2));
			if (folder !== undefined) {
				folders.push(folder);
			}
		}
		return folders;
	}
	return undefined;
}

/**
 * The sections the host wraps around a prompt: what Copilot holds for the chat
 * as a whole — the environment, the layout of the workspace, the preferences of
 * the user and the memory it loaded. An agent has its own way to see those, so
 * they are kept out of the text of a message; they are forwarded once instead,
 * when a session that has seen nothing starts.
 *
 * This is the VS Code host's knowledge: no other host renders these sections,
 * and nothing in `src/engine` may name them.
 */
const COPILOT_CONTEXT = /<(environment_info|workspace_info|userMemory|sessionMemory|repoMemory)>[\s\S]*?<\/\1>/g;

/** The same sections, collected from the messages ahead of the first request. */
const CHAT_CONTEXT = /<(environment_info|workspace_info|userMemory|sessionMemory|repoMemory)>[\s\S]*?<\/\1>/g;

/** What Copilot wraps the words of the user in; the first message carrying one is where the chat starts. */
const USER_REQUEST = /<userRequest>[\s\S]*?<\/userRequest>/;

/** Takes the host's own context sections out of text the engine forwards. */
export function stripHostSections(text: string): string {
	return text.replace(COPILOT_CONTEXT, '');
}

/**
 * The context Copilot holds for the chat as a whole, which it sends ahead of the
 * first request: the environment, the layout of the workspace, the preferences
 * of the user and the memory it loaded. Native keeps it in the conversation as
 * one message, so it is forwarded once, when a session that has seen nothing
 * starts, and never again with a turn.
 */
export function chatWideContextOf(messages: readonly ChatMessage[]): string | undefined {
	const sections: string[] = [];

	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		const text = textOfMessage(message);
		// The message carrying the request is where the conversation starts.
		if (USER_REQUEST.test(text)) {
			break;
		}
		for (const match of text.matchAll(CHAT_CONTEXT)) {
			sections.push(match[0]);
		}
	}

	return sections.length === 0 ? undefined : sections.join('\n\n');
}

/** The marker Copilot writes into its prompt for its own cache breakpoints, which mean nothing to an agent. */
const CACHE_CONTROL = /\[copilot_cache_control:[^\]\n]*\]/g;

/**
 * The guidance the host writes in the system message of the request, which the
 * agent would otherwise never see: its own prompt describes no workspace, and
 * these sections carry the working directory, the rules of the repository, the
 * guidance for the tools it offers, and the preferences of the user for this
 * conversation.
 *
 * Only the personality is left out (`IDENTITY_PATTERNS`): the agent has a name
 * and a voice of its own. Everything else the host wrote is kept as it stands,
 * including the behaviour it states ahead of its first section — its skill and
 * agent lists, its index of instruction files and its rules for the memory tool
 * all reach the agent in the host's own words. Text the user or the agent wrote
 * is never read: only a system message counts. A host that sends more than one
 * system message contributes each.
 */
export function systemGuidanceOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | undefined {
	const sections: string[] = [];

	for (const message of messages) {
		if (!isSystemMessage(message)) {
			continue;
		}
		const section = stripIdentity(textOf(message).replace(CACHE_CONTROL, '')).trim();
		if (section.length > 0) {
			sections.push(section);
		}
	}

	if (sections.length === 0) {
		return undefined;
	}
	return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The chat id Copilot adds to the model options, when it adds one. */
export function conversationIdOf(options: vscode.ProvideLanguageModelChatResponseOptions | undefined): string | undefined {
	const id = options?.modelOptions?._conversationId;
	return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The folder to root the agent in: the first of the chat's own folders that
 * exists on this machine, otherwise the window's folder.
 */
export function resolveCwd(chatFolders: readonly string[] | undefined, windowCwd: string, exists: (folder: string) => boolean = fs.existsSync): string {
	return chatFolders?.find(folder => exists(folder)) ?? windowCwd;
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
