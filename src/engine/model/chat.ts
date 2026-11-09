/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Who a message in a chat comes from. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * One piece of a message. A tool's arguments travel in the call and its output
 * in the result, so a host can hand either back without the engine knowing how
 * the tool ran.
 */
export type Part =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: Uint8Array; readonly mimeType: string }
	| { readonly type: 'tool-call'; readonly callId: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'tool-result'; readonly callId: string; readonly content: readonly Part[]; readonly isError?: boolean };
export interface ChatMessage { readonly role: ChatRole; readonly parts: readonly Part[]; readonly name?: string }

/** One tool the model may call, described by the JSON schema the agent is sent. */
export interface ToolDef { readonly name: string; readonly description: string; readonly inputSchema: unknown }

/** One turn of a chat, as the host gathered it. */
export interface ChatRequest {
	/** Stable for the chat across turns, whichever host sends it. */
	readonly chatId: string;
	/** The folder the chat works in. */
	readonly cwd: string;
	readonly messages: readonly ChatMessage[];
	readonly tools: readonly ToolDef[];
	readonly model?: string;
	/** The reasoning effort the user picked, when the host has one. */
	readonly effort?: string;
	/** The workspace guidance the host wrote into the request. */
	readonly systemGuidance?: string;
}

/** What running a tool produced. */
export interface ToolResult { readonly content: readonly Part[]; readonly isError?: boolean }
