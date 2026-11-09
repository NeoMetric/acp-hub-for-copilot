/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { stripIdentity } from '../../core/identityPatterns';
import { acpModelValue, effortOf } from '../../core/models';
import type { ChatMessage } from '../../engine/model/chat';
import type { AcpRequestExtras } from '../http/wire';
import { chatIdOf, chatLabelOf, chatWideContextOf, resolveCwd, sessionKey, stripHostSections, systemGuidanceOf, workspaceFoldersOf } from './identity';

/**
 * The body of one chat request, as the server reads it. It carries what the
 * workbench sent — the conversation, its tools, the effort the picker chose —
 * and, in the `acp` field, the chat context Copilot names nowhere but in the
 * text of its own prompt.
 */

/** One content part of a message, as the server reads one. */
type WireContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

interface WireToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: { readonly name: string; readonly arguments: string };
}

interface WireMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content?: string | readonly WireContent[];
	readonly tool_calls?: readonly WireToolCall[];
	readonly tool_call_id?: string;
}

interface ChatBody {
	readonly model: string;
	readonly stream: true;
	readonly messages: readonly WireMessage[];
	readonly tools?: readonly unknown[];
	readonly reasoning_effort?: string;
	readonly acp: AcpRequestExtras;
}

/**
 * Translates one workbench request into the body of `POST /v1/chat/completions`.
 * `windowFolder` roots a chat whose own folders this machine does not have, and
 * `agentId` only prefixes the model id: the server reads the agent from it.
 */
export function bodyOf(
	model: vscode.LanguageModelChatInformation,
	agentId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
	windowFolder: string,
): unknown {
	const folders = workspaceFoldersOf(messages);
	const effort = effortOf(options);
	const guidance = stripIdentity(systemGuidanceOf(messages) ?? '').trim();
	const chatContext = chatWideContextOf(messages.map(engineMessageOf));
	const tools = options.tools ?? [];
	const body: ChatBody = {
		model: `${agentId}/${acpModelValue(model.id)}`,
		stream: true,
		messages: messages.flatMap(wireMessagesOf),
		...(tools.length > 0 ? { tools: tools.map(toolOf) } : {}),
		...(effort === undefined ? {} : { reasoning_effort: effort }),
		acp: {
			sessionKey: sessionKey(messages, options),
			chatId: chatIdOf(messages, options),
			label: chatLabelOf(messages),
			cwd: resolveCwd(folders, windowFolder),
			workspaceFolders: [...(folders ?? [])],
			...(guidance.length === 0 ? {} : { systemGuidance: guidance }),
			...(chatContext === undefined ? {} : { chatContext }),
		},
	};
	return body;
}

/** One workbench message as the server reads it: one message, or a tool result beside it. */
function wireMessagesOf(message: vscode.LanguageModelChatRequestMessage): WireMessage[] {
	const role = roleOf(message);
	if (role === 'system') {
		const content = outgoingTextOf(message);
		return content === undefined ? [] : [{ role, content }];
	}
	if (role === 'assistant') {
		const content = outgoingTextOf(message);
		const calls = message.content.flatMap(wireCallOf);
		if (content === undefined && calls.length === 0) {
			return [];
		}
		return [{ role, ...(content === undefined ? {} : { content }), ...(calls.length === 0 ? {} : { tool_calls: calls }) }];
	}

	// The words and images of a user message stay together; a tool result is the
	// message that answers its call, so it travels on its own.
	const wire: WireMessage[] = [];
	let content: WireContent[] = [];
	const flush = (): void => {
		if (content.length > 0) {
			wire.push({ role: 'user', content: collapsed(content) });
		}
		content = [];
	};
	for (const part of message.content) {
		const result = wireResultOf(part);
		if (result) {
			flush();
			wire.push(result);
			continue;
		}
		const item = wireContentOf(part);
		if (item) {
			content.push(item);
		}
	}
	flush();
	return wire;
}

function roleOf(message: vscode.LanguageModelChatRequestMessage): 'system' | 'user' | 'assistant' {
	if (message.role === vscode.LanguageModelChatMessageRole.User) {
		return 'user';
	}
	return message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system';
}

/** The text of a message as it is forwarded: the host's own sections belong to no agent. */
function outgoingTextOf(message: vscode.LanguageModelChatRequestMessage): string | undefined {
	const text = textPartsOf(message).map(stripHostSections).join('\n');
	return text.trim().length > 0 ? text : undefined;
}

function textPartsOf(message: vscode.LanguageModelChatRequestMessage): string[] {
	return message.content.flatMap(part => typeof part === 'string' ? [part] : part instanceof vscode.LanguageModelTextPart ? [part.value] : []);
}

function wireContentOf(part: unknown): WireContent | undefined {
	const text = typeof part === 'string' ? part
		: part instanceof vscode.LanguageModelTextPart ? part.value
			: undefined;
	if (text !== undefined) {
		const stripped = stripHostSections(text);
		return stripped.trim().length === 0 ? undefined : { type: 'text', text: stripped };
	}
	if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
		return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } };
	}
	return undefined;
}

function wireCallOf(part: unknown): WireToolCall[] {
	return part instanceof vscode.LanguageModelToolCallPart
		? [{ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } }]
		: [];
}

/** A tool result as the `tool` message that answers its call. */
function wireResultOf(part: unknown): WireMessage | undefined {
	if (!(part instanceof vscode.LanguageModelToolResultPart)) {
		return undefined;
	}
	const content = (part.content as readonly unknown[]).flatMap(item => wireContentOf(item) ?? []);
	const failed = (part as { readonly isError?: boolean }).isError === true;
	return { role: 'tool', tool_call_id: part.callId, content: failed ? failureOf(content) : collapsed(content) };
}

/** A client that ran a tool and failed it says so in the text — `error: …` — which is how the server reads a failure. */
function failureOf(content: readonly WireContent[]): string | WireContent[] {
	const first = content.findIndex(item => item.type === 'text');
	const items = [...content];
	if (first < 0) {
		items.unshift({ type: 'text', text: 'error:' });
	} else {
		const text = items[first];
		items[first] = { type: 'text', text: text.type === 'text' ? `error: ${text.text}` : 'error:' };
	}
	return collapsed(items);
}

/** Content as the server reads it: one string when it is all text, parts when an image travels with them. */
function collapsed(content: readonly WireContent[]): string | WireContent[] {
	if (content.every(item => item.type === 'text')) {
		return content.map(item => item.type === 'text' ? item.text : '').join('\n');
	}
	return [...content];
}

function toolOf(tool: vscode.LanguageModelChatTool): unknown {
	return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

/**
 * The engine's view of one message, which only the chat-wide context needs: its
 * sections are always written as text, so no other part is converted.
 */
function engineMessageOf(message: vscode.LanguageModelChatRequestMessage): ChatMessage {
	const role = roleOf(message);
	return {
		role,
		name: message.name,
		parts: textPartsOf(message).map(text => ({ type: 'text' as const, text })),
	};
}
