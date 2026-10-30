/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { chatContextBlock, customInstructionsBlock, toAcpContentBlocks, toTranscriptBlock, type AcpContentBlock } from '../convert';
import type { Log } from '../logging';
import { shortHash } from '../sessionStore';
import type { ChatSession } from './types';

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
	const instructions = customInstructionsBlock(messages);
	const instructionsHash = instructions ? shortHash(instructions.text) : undefined;
	if (instructions && instructionsHash !== session.instructionsHash) {
		log(`Forwarding ${instructions.text.length} character(s) of user and mode instructions.`, 'debug');
		preamble.push(instructions);
		session.instructionsHash = instructionsHash;
	}
	if (restoreContext && lastUser > 0) {
		log(`Roles of the first messages being restored: ${messages.slice(0, 3).map(message => message.role).join(', ')}`, 'debug');
		const transcript = toTranscriptBlock(messages.slice(0, lastUser));
		if (transcript) {
			log(`Restoring ${lastUser} earlier message(s) into the new ACP session.`);
			preamble.push(transcript);
		}
	}
	return [...preamble, ...toAcpContentBlocks(messages.slice(startIndex))];
}
