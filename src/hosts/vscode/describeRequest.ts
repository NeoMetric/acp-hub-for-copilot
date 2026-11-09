/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type DescribedPart =
	| { readonly kind: 'text'; readonly chars: number; readonly tags: string[]; readonly text: string }
	| { readonly kind: 'data'; readonly mimeType: string; readonly bytes: number }
	| { readonly kind: 'tool-call'; readonly name: string; readonly callId: string }
	| { readonly kind: 'tool-result'; readonly callId: string }
	| { readonly kind: 'other'; readonly type: string };

export interface RequestDescription {
	readonly messages: ReadonlyArray<{ readonly index: number; readonly role: number; readonly name: string | undefined; readonly parts: DescribedPart[] }>;
	readonly options: {
		readonly toolCount: number;
		readonly toolNames: string[];
		readonly toolMode: unknown;
		/** Every key Copilot set, with its value as JSON cut to a short length. */
		readonly modelOptions: Record<string, string>;
		readonly modelConfiguration: Record<string, string>;
	};
}

const MAX_TAGS = 40;
const MAX_VALUE_CHARS = 200;

/** Tag names whose closing tag also appears, so comparisons and generics are not mistaken for tags. */
function tagsOf(text: string): string[] {
	const tags: string[] = [];
	for (const match of text.matchAll(/<([A-Za-z_][\w-]*)(?:\s[^>]*)?>/g)) {
		const name = match[1];
		if (!tags.includes(name) && text.includes(`</${name}>`)) {
			tags.push(name);
			if (tags.length === MAX_TAGS) {
				break;
			}
		}
	}
	return tags;
}

function shorten(text: string, length: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

function valuesOf(record: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (record && typeof record === 'object') {
		for (const [key, value] of Object.entries(record)) {
			const json = JSON.stringify(value) ?? 'undefined';
			result[key] = json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : json;
		}
	}
	return result;
}

/**
 * A plain description of what Copilot sent, for working out which parts of it
 * a provider can use. `previewLength` cuts each text part; pass `Infinity` to
 * keep the whole request.
 */
export function describeRequest(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
	{ previewLength = 160 }: { previewLength?: number } = {},
): RequestDescription {
	const tools = options.tools ?? [];

	return {
		messages: messages.map((message, index) => ({
			index,
			role: message.role as number,
			name: message.name,
			parts: message.content.map(part => describePart(part, previewLength)),
		})),
		options: {
			toolCount: tools.length,
			toolNames: tools.map(tool => tool.name),
			toolMode: options.toolMode,
			modelOptions: valuesOf(options.modelOptions),
			modelConfiguration: valuesOf((options as { modelConfiguration?: unknown }).modelConfiguration),
		},
	};
}

function describePart(part: unknown, previewLength: number): DescribedPart {
	if (part instanceof vscode.LanguageModelTextPart) {
		const text = part.value;
		return { kind: 'text', chars: text.length, tags: tagsOf(text), text: previewLength === Infinity ? text : shorten(text, previewLength) };
	}
	if (part instanceof vscode.LanguageModelDataPart) {
		return { kind: 'data', mimeType: part.mimeType, bytes: part.data.length };
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return { kind: 'tool-call', name: part.name, callId: part.callId };
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return { kind: 'tool-result', callId: part.callId };
	}
	return { kind: 'other', type: (part as { constructor?: { name?: string } })?.constructor?.name ?? typeof part };
}
