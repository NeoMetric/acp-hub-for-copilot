/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Stand-in size of an image, which has no text to measure (about 1,200 tokens). */
const IMAGE_CHARACTERS = 4_800;

/**
 * How many characters a message weighs for token estimates: its text plus the
 * tool calls and tool results that plain text leaves out, and a flat size per image.
 */
export function characterCountOf(message: vscode.LanguageModelChatRequestMessage): number {
	return countCharacters(message.content);
}

function countCharacters(parts: readonly unknown[]): number {
	let total = 0;

	for (const part of parts) {
		if (typeof part === 'string') {
			total += part.length;
		} else if (part instanceof vscode.LanguageModelTextPart) {
			total += part.value.length;
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			total += part.name.length + JSON.stringify(part.input ?? {}).length;
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			total += countCharacters(part.content);
		} else if (part instanceof vscode.LanguageModelDataPart) {
			total += part.mimeType.startsWith('image/') ? IMAGE_CHARACTERS : 0;
		} else if (part !== null && typeof part === 'object') {
			// Prompt-tsx and other structured parts: measure what they serialise to.
			total += JSON.stringify(part)?.length ?? 0;
		}
	}

	return total;
}
