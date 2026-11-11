/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Reminders Copilot adds to a user message, such as the tools or guidance in force. */
const SYSTEM_REMINDERS = /<system_reminder>[\s\S]*?<\/system_reminder>\s*/g;

/** What the editor had selected or open when the message was sent; it changes with the cursor, not with what was said. */
const IDE_CONTEXT = /<(ide_selection|ide_opened_file)>[\s\S]*?<\/\1>\s*/g;

const CUSTOM_INSTRUCTIONS = /(?:^[^\n<]*user provided coding instructions[^\n]*\r?\n)?<instructions>[\s\S]*?<\/instructions>|<modeInstructions>[\s\S]*?<\/modeInstructions>/gm;

/** The role a system prompt arrives with; the stable API names only `User` and `Assistant`. */
const SYSTEM_ROLE = 3;

/** Whether the host sent this message as its system prompt rather than as part of the conversation. */
export function isSystemMessage(message: vscode.LanguageModelChatRequestMessage): boolean {
	return (message.role as number) === SYSTEM_ROLE;
}

/** Concatenated text of a message, ignoring non-text parts. */
export function textOf(message: vscode.LanguageModelChatRequestMessage): string {
	const parts: string[] = [];

	for (const part of message.content) {
		if (typeof part === 'string') {
			parts.push(part);
		} else if (part instanceof vscode.LanguageModelTextPart) {
			parts.push(part.value);
		}
	}

	return parts.join('\n');
}

/** Hashes of attachments already seen; every request repeats the whole history. */
const imageHashes = new WeakMap<vscode.LanguageModelDataPart, string>();

/** FNV-1a, enough to notice that two attachments differ. */
function hashBytes(bytes: Uint8Array): string {
	let result = 0x811c9dc5;
	for (let index = 0; index < bytes.length; index++) {
		result ^= bytes[index];
		result = Math.imul(result, 0x01000193);
	}
	return (result >>> 0).toString(16);
}

/** A short, stable marker for the images of a message, used to spot changes. */
export function imageFingerprint(message: vscode.LanguageModelChatRequestMessage): string {
	const markers: string[] = [];

	for (const part of message.content) {
		if (!(part instanceof vscode.LanguageModelDataPart) || !part.mimeType.startsWith('image/')) {
			continue;
		}
		let digest = imageHashes.get(part);
		if (digest === undefined) {
			digest = hashBytes(part.data);
			imageHashes.set(part, digest);
		}
		markers.push(`${part.mimeType}:${part.data.length}:${digest}`);
	}

	return markers.join(',');
}

/**
 * A stable description of one Copilot message, used to notice history changes.
 *
 * A system message is described by its role alone. The host renders it afresh
 * for every request, and it has been seen to change between requests of one
 * chat (the casing of a drive letter, for one), which is no change to what was
 * said. Treating that as a rewritten history would start a new session on
 * every turn and lose what the agent had learned.
 */
export function fingerprint(message: vscode.LanguageModelChatRequestMessage): string {
	if (isSystemMessage(message)) {
		return `${message.role}:system`;
	}

	const parts: string[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelToolCallPart) {
			parts.push(`call:${part.callId}:${part.name}`);
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			parts.push(`result:${part.callId}`);
		}
	}

	// The instructions of the mode change when the user switches modes, which is no rewrite of the chat.
	// Copilot also adds reminders about the tools and guidance to a user message, so a tool toggle
	// rewrites an earlier message; those reminders are no change to what was said either. Nor is the
	// IDE selection, which a resend carries as it is at that moment.
	return `${message.role}:${textOf(message).replace(CUSTOM_INSTRUCTIONS, '').replace(SYSTEM_REMINDERS, '').replace(IDE_CONTEXT, '')}:${imageFingerprint(message)}:${parts.join(',')}`;
}
