/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { chatContextBlock, customInstructionsBlock, firstUserWordsIn, readTranscriptOptions, toAcpContentBlocks, toTranscriptBlock, type AcpContentBlock, type AcpTextBlock } from '../convert';
import type { Log } from '../logging';
import { shortHash } from '../sessionStore';
import type { ChatSession, GuidanceChange } from './types';

/** Roomy enough for the instructions of a long custom mode, which must arrive whole. */
const GUIDANCE_CHANGE_MAX_CHARACTERS = 40_000;
const GONE_LINES_SHOWN = 20;
const GONE_LINE_PREVIEW_CHARACTERS = 80;

/** Tells a resumed session how the host's guidance has changed since the session was opened. */
export function guidanceChangeBlock(change: GuidanceChange): AcpTextBlock {
	const header = 'The workspace guidance for this conversation changed since your session was opened.';
	const lines: string[] = [];

	if (change.added.length > 0) {
		const added = change.added.join('\n');
		const shown = added.length > GUIDANCE_CHANGE_MAX_CHARACTERS ? `${added.slice(0, GUIDANCE_CHANGE_MAX_CHARACTERS)}\n…` : added;
		lines.push(`${header} These lines are new or reworded, and they take precedence over the earlier guidance:`, '<guidance_update>', shown, '</guidance_update>');
	} else {
		lines.push(header);
	}

	// The instructions of a mode that was left are named, not repeated: they are in the session already.
	if (change.leftMode !== undefined) {
		lines.push(`You are no longer in "${change.leftMode}" mode; its instructions no longer apply.`);
	}
	if (change.goneLines === undefined) {
		if (change.removed > 0) {
			lines.push(`${change.removed} line(s) of the earlier guidance no longer apply.`);
		}
	} else if (change.goneLines.length > 0) {
		const previews = change.goneLines.slice(0, GONE_LINES_SHOWN).map(line => `- ${line.length > GONE_LINE_PREVIEW_CHARACTERS ? `${line.slice(0, GONE_LINE_PREVIEW_CHARACTERS)}…` : line}`);
		const more = change.goneLines.length - previews.length;
		lines.push('These lines of the earlier guidance no longer apply:', ...previews, ...(more > 0 ? [`- … and ${more} more`] : []));
	}

	return { type: 'text', text: lines.join('\n') };
}

/**
 * The prompt for one turn: the messages the agent has not seen, preceded by
 * whatever it needs to catch up. A session that has seen nothing yet gets the
 * context of the chat and a transcript of what came before (`restoreContext`),
 * and any change to the user's instructions is sent once.
 */
export function buildPromptBlocks(messages: readonly vscode.LanguageModelChatRequestMessage[], startIndex: number, lastUser: number, restoreContext: boolean, session: ChatSession, log: Log): AcpContentBlock[] {
	const preamble: AcpContentBlock[] = [];
	if (restoreContext) {
		// The context of the chat comes first, as it does in the prompt the host renders.
		const chatContext = chatContextBlock(messages.slice(0, lastUser));
		if (chatContext) {
			log(`Forwarding ${chatContext.text.length} character(s) of context for the chat.`, 'debug');
			preamble.push(chatContext);
		}
	}
	if (session.guidanceChange) {
		log(`Forwarding the guidance change: ${session.guidanceChange.added.length} new line(s), ${session.guidanceChange.removed} gone.`, 'debug');
		preamble.push(guidanceChangeBlock(session.guidanceChange));
		session.guidanceChange = undefined;
	}
	const instructions = customInstructionsBlock(messages);
	const instructionsHash = instructions ? shortHash(instructions.text) : undefined;
	if (instructions && instructionsHash !== session.instructionsHash) {
		log(`Forwarding ${instructions.text.length} character(s) of user and mode instructions.`, 'debug');
		preamble.push(instructions);
		session.instructionsHash = instructionsHash;
	}
	if (restoreContext && lastUser > 0) {
		log(`Roles of the first messages being restored: ${messages.slice(0, 3).map(message => message.role).join(', ')}`, 'debug');
		const transcript = toTranscriptBlock(messages.slice(0, lastUser), readTranscriptOptions());
		if (transcript) {
			log(`Restoring ${lastUser} earlier message(s) into the new ACP session.`);
			preamble.push(transcript);
		}
	}
	// Another agent answered part of the chat since this session last ran: its replies and
	// tool calls are not in this session, and a prompt carries only user messages, so that
	// stretch goes in as a transcript. The session's own last reply comes before the first
	// message the user said in it, so it is left out.
	const missed = restoreContext ? -1 : firstUserWordsIn(messages, startIndex, lastUser);
	if (missed >= 0) {
		const transcript = toTranscriptBlock(messages.slice(missed, lastUser), readTranscriptOptions(), true);
		if (transcript) {
			log(`Catching the session up on ${lastUser - missed} message(s) answered by another agent.`);
			preamble.push(transcript);
		}
		return [...preamble, ...toAcpContentBlocks(messages.slice(lastUser))];
	}
	return [...preamble, ...toAcpContentBlocks(messages.slice(startIndex))];
}
