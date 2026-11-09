/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AcpContentBlock, AcpImageBlock, AcpTextBlock } from '../acp/protocol';
import type { ChatMessage, Part } from '../model/chat';

/**
 * The roles as the host's own message API numbers them. A fingerprint of a
 * message is persisted with the saved session, so it keeps the shape it has
 * always had and a chat saved by an earlier build still resumes.
 */
const ROLE_NUMBER = { user: 1, assistant: 2, system: 3, tool: 4 } as const;

const USER_REQUEST = /<userRequest>([\s\S]*?)<\/userRequest>/;
const ATTACHMENTS = /<attachments>[\s\S]*?<\/attachments>/;
/**
 * The host's context for the chat as a whole. It is forwarded once, when a
 * session starts, and kept out of the per-turn text so that it is neither sent
 * again with every message nor repeated in a restored transcript.
 */
const COPILOT_CONTEXT = /<(environment_info|workspace_info|userMemory|sessionMemory|repoMemory)>[\s\S]*?<\/\1>/g;
/**
 * What the host knows about this turn alone: the clock, the files that changed,
 * the todo list, the terminal, the open editor, and the reminders it repeats
 * next to the request. The agent has no other way to see it, and it is only
 * ever sent with the turn it belongs to.
 */
const TURN_STATE = /<(context|editorContext|reminderInstructions|toolReferences|notebookFormatInstructions)>[\s\S]*?<\/\1>/g;
const CHAT_CONTEXT = /<(environment_info|workspace_info|userMemory|sessionMemory|repoMemory)>[\s\S]*?<\/\1>/g;
/** Reminders the host adds to a user message, such as the tools or guidance in force. */
const SYSTEM_REMINDERS = /<system_reminder>[\s\S]*?<\/system_reminder>\s*/g;
/** What the editor had selected or open when the message was sent; it changes with the cursor, not with what was said. */
const IDE_CONTEXT = /<(ide_selection|ide_opened_file)>[\s\S]*?<\/\1>\s*/g;
const CUSTOM_INSTRUCTIONS = /(?:^[^\n<]*user provided coding instructions[^\n]*\r?\n)?<instructions>[\s\S]*?<\/instructions>|<modeInstructions>[\s\S]*?<\/modeInstructions>/gm;

/** Concatenated text of a message, ignoring every other part. */
export function textOf(message: ChatMessage): string {
	return message.parts.filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text').map(part => part.text).join('\n');
}

const imagePartsOf = (message: ChatMessage): Array<Extract<Part, { type: 'image' }>> =>
	message.parts.filter((part): part is Extract<Part, { type: 'image' }> => part.type === 'image');
const toolCallsOf = (message: ChatMessage): Array<Extract<Part, { type: 'tool-call' }>> =>
	message.parts.filter((part): part is Extract<Part, { type: 'tool-call' }> => part.type === 'tool-call');
const toolResultsOf = (message: ChatMessage): Array<Extract<Part, { type: 'tool-result' }>> =>
	message.parts.filter((part): part is Extract<Part, { type: 'tool-result' }> => part.type === 'tool-result');

/**
 * What the user actually said, with the state of the turn it belongs to.
 * The host wraps each request in context of its own (environment, workspace
 * layout, memory); the agent has its own for those, so only the request, its
 * attachments and the turn's state are kept. A message that carries that
 * context without a request, as the host sends it ahead of the first one, comes
 * out empty.
 */
export function promptTextOf(message: ChatMessage): string {
	const text = textOf(message);
	const request = USER_REQUEST.exec(text);
	if (!request) {
		// The instructions of the user and of the mode reach the agent through `customInstructionsBlock`.
		const withoutContext = text.replace(COPILOT_CONTEXT, '').replace(CUSTOM_INSTRUCTIONS, '');
		return withoutContext === text ? text : withoutContext.trim();
	}
	const kept: string[] = [];
	// Native puts what the user attached first, then the state of the turn, then the request.
	kept.push(ATTACHMENTS.exec(text)?.[0] ?? '');
	kept.push(...[...text.matchAll(TURN_STATE)].map(match => match[0]));
	kept.push(request[1].trim());
	return kept.filter(part => part).join('\n\n');
}

/**
 * The instructions of the user and of the mode in the user messages of a
 * request, each once however many messages repeat it. The host renders them
 * afresh for every request, so the caller sends the block only when its text
 * differs from the one the session already has.
 */
export function customInstructionsBlock(messages: readonly ChatMessage[]): AcpTextBlock | undefined {
	const parts: string[] = [];

	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		// What the user attached is not an instruction of the host's, even when it contains the tag.
		const text = textOf(message).replace(new RegExp(ATTACHMENTS.source, 'g'), '');
		for (const match of text.matchAll(CUSTOM_INSTRUCTIONS)) {
			const part = match[0].trim();
			if (!parts.includes(part)) {
				parts.push(part);
			}
		}
	}

	return parts.length === 0 ? undefined : { type: 'text', text: parts.join('\n\n') };
}

export function chatContextBlock(messages: readonly ChatMessage[]): AcpTextBlock | undefined {
	const parts: string[] = [];

	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		const text = textOf(message);
		// The message carrying the request is where the conversation starts.
		if (USER_REQUEST.test(text)) {
			break;
		}
		for (const match of text.matchAll(CHAT_CONTEXT)) {
			parts.push(match[0]);
		}
	}

	return parts.length === 0 ? undefined : { type: 'text', text: parts.join('\n\n') };
}

/** The image blocks of a message, in the order the images were attached. */
export function imageBlocksOf(message: ChatMessage): AcpImageBlock[] {
	return imagePartsOf(message).map(part => ({
		type: 'image',
		data: Buffer.from(part.data).toString('base64'),
		mimeType: part.mimeType,
	}));
}

/** Hashes of attachments already seen; every request repeats the whole history. */
const imageHashes = new WeakMap<Extract<Part, { type: 'image' }>, string>();

/** A short, stable marker for the images of a message, used to spot changes. */
export function imageFingerprint(message: ChatMessage): string {
	return imagePartsOf(message).map(part => {
		let digest = imageHashes.get(part);
		if (digest === undefined) {
			digest = hashBytes(part.data);
			imageHashes.set(part, digest);
		}
		return `${part.mimeType}:${part.data.length}:${digest}`;
	}).join(',');
}

/** FNV-1a, enough to notice that two attachments differ. */
function hashBytes(bytes: Uint8Array): string {
	let result = 0x811c9dc5;
	for (let index = 0; index < bytes.length; index++) {
		result ^= bytes[index];
		result = Math.imul(result, 0x01000193);
	}
	return (result >>> 0).toString(16);
}

/** Whether the host sent this message as its system prompt rather than as part of the conversation. */
export function isSystemMessage(message: ChatMessage): boolean {
	return message.role === 'system';
}

/**
 * A stable description of one message, used to notice history changes.
 *
 * A system message is described by its role alone. The host renders it afresh
 * for every request, and it has been seen to change between requests of one
 * chat (the casing of a drive letter, for one), which is no change to what was
 * said. Treating that as a rewritten history would start a new session on
 * every turn and lose what the agent had learned.
 */
export function fingerprint(message: ChatMessage): string {
	if (isSystemMessage(message)) {
		return `${ROLE_NUMBER[message.role]}:system`;
	}

	const parts = [
		...toolCallsOf(message).map(call => `call:${call.callId}:${call.name}`),
		...toolResultsOf(message).map(result => `result:${result.callId}`),
	];

	// The instructions of the mode change when the user switches modes, which is no rewrite of the chat.
	// The host also adds reminders about the tools and guidance to a user message, so a tool toggle
	// rewrites an earlier message; those reminders are no change to what was said either. Nor is the
	// IDE selection, which a resend carries as it is at that moment.
	return `${ROLE_NUMBER[message.role]}:${textOf(message).replace(CUSTOM_INSTRUCTIONS, '').replace(SYSTEM_REMINDERS, '').replace(IDE_CONTEXT, '')}:${imageFingerprint(message)}:${parts.join(',')}`;
}

/**
 * The fingerprints of the messages that stay in the chat. While tools are deferred, the host
 * ends a request with a user message that holds nothing but a `<system_reminder>` listing them,
 * and leaves it out of the next request, so it is no part of the conversation.
 */
export function persistentFingerprints(messages: readonly ChatMessage[]): string[] {
	let end = messages.length;

	while (end > 0 && isReminderOnly(messages[end - 1])) {
		end--;
	}

	return messages.slice(0, end).map(fingerprint);
}

function isReminderOnly(message: ChatMessage): boolean {
	if (message.role !== 'user' || isSystemMessage(message)) {
		return false;
	}
	if (!message.parts.every(part => part.type === 'text')) {
		return false;
	}
	const text = textOf(message);
	return text.includes('<system_reminder>') && text.replace(SYSTEM_REMINDERS, '').trim().length === 0;
}

/** Whether the messages the session has seen are no longer a prefix of the chat. */
export function diverged(history: readonly string[], fingerprints: readonly string[]): boolean {
	for (let index = 0; index < history.length; index++) {
		if (history[index] !== fingerprints[index]) {
			return true;
		}
	}
	return false;
}

/**
 * The newest user message that says something. Messages that only carry tool
 * results are skipped, as there is nothing in them to forward as a prompt.
 */
export function lastUserMessageIndex(messages: readonly ChatMessage[]): number {
	let lastUser = -1;

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== 'user') {
			continue;
		}
		if (lastUser < 0) {
			lastUser = index;
		}
		if (saysSomething(message)) {
			return index;
		}
	}

	return Math.max(lastUser, 0);
}

const saysSomething = (message: ChatMessage): boolean => textOf(message).trim().length > 0 || imagePartsOf(message).length > 0;

/**
 * The first message in `[from, to)` where the user said something, or -1. Past a
 * session's last reply the only such message is normally the newest one, so one
 * further back means another agent answered the chat in between.
 */
export function firstUserWordsIn(messages: readonly ChatMessage[], from: number, to: number): number {
	for (let index = Math.max(from, 0); index < Math.min(to, messages.length); index++) {
		if (messages[index].role === 'user' && saysSomething(messages[index])) {
			return index;
		}
	}

	return -1;
}

/** Where the messages the agent has not answered start: right after its last reply. */
export function firstMessageAfterReply(messages: readonly ChatMessage[]): number {
	let first = messages.length;

	while (first > 0 && messages[first - 1].role !== 'assistant') {
		first--;
	}

	return first;
}

/** Skill context can be emitted separately from its result by the host. */
export function skillContextAfterReply(messages: readonly ChatMessage[]): { callId: string; text: string } | undefined {
	const recent = messages.slice(firstMessageAfterReply(messages));
	const results = recent.flatMap(toolResultsOf);
	const contexts = recent.filter(message => message.role === 'user')
		.map(message => textOf(message).trim())
		.filter(text => /^<skill-context(?:\s[^>]*)?>[\s\S]*<\/skill-context>$/.test(text));
	if (results.length !== 1 || contexts.length !== 1) {
		return undefined;
	}
	return { callId: results[0].callId, text: contexts[0] };
}

/**
 * What the user said since the agent's last reply, apart from tool results.
 * The host delivers a message typed while a turn runs next to the results of
 * the tool call that was waiting, so it arrives in the request that would
 * continue the turn.
 */
export function userWordsAfterReply(messages: readonly ChatMessage[]): Part[] {
	const words: Part[] = [];
	const skillContext = skillContextAfterReply(messages);

	for (const message of messages.slice(firstMessageAfterReply(messages))) {
		if (message.role !== 'user') {
			continue;
		}
		const text = promptTextOf(message).trim();
		if (text.length > 0 && text !== skillContext?.text) {
			words.push({ type: 'text', text });
		}
		for (const part of imagePartsOf(message)) {
			words.push(part);
		}
	}

	return words;
}

/** Whether the messages since the agent's last reply carry a tool result. */
export function carriesToolResults(messages: readonly ChatMessage[]): boolean {
	return messages.slice(firstMessageAfterReply(messages)).some(message => toolResultsOf(message).length > 0);
}

/**
 * Converts chat messages into ACP prompt content blocks.
 *
 * Only user text and images are forwarded: tool calls and tool results are
 * ignored, because the agent runs tools itself over the MCP bridge.
 */
export function toAcpContentBlocks(messages: readonly ChatMessage[]): AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [];

	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}

		const text = promptTextOf(message);
		if (text.trim().length > 0) {
			blocks.push({ type: 'text', text });
		}
		blocks.push(...imageBlocksOf(message));
	}

	return blocks;
}

/** Upper bound for the restored conversation, so a long chat cannot swamp the new turn. */
export const TRANSCRIPT_MAX_CHARACTERS = 40_000;

/** Upper bound for one tool result in a `full` transcript, so a single file read cannot crowd out the rest. */
export const TRANSCRIPT_MAX_TOOL_RESULT_CHARACTERS = 4_000;

/** Upper bound for the arguments of one tool call in a `full` transcript. */
const TRANSCRIPT_MAX_TOOL_INPUT_CHARACTERS = 1_000;

export interface TranscriptOptions {
	/** `compact` names the tools that ran; `full` also includes their arguments and results as text. */
	readonly detail: 'compact' | 'full';
	readonly maxCharacters: number;
	readonly maxToolResultCharacters: number;
}

export const DEFAULT_TRANSCRIPT_OPTIONS: TranscriptOptions = {
	detail: 'compact',
	maxCharacters: TRANSCRIPT_MAX_CHARACTERS,
	maxToolResultCharacters: TRANSCRIPT_MAX_TOOL_RESULT_CHARACTERS,
};

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more character(s) cut]` : text;
}

function toolResultText(part: Extract<Part, { type: 'tool-result' }>): string {
	return part.content.map(item => item.type === 'text' ? item.text : '').filter(text => text.length > 0).join('\n');
}

/**
 * Renders earlier messages as one text block, for an ACP session that did not
 * live through them: after a window reload, an agent restart, or an edit that
 * rewrote the history. The newest messages win when the budget runs out.
 * `missed` words the framing for a live session that did not answer part of
 * the chat, because the user had another agent answer it.
 */
export function toTranscriptBlock(messages: readonly ChatMessage[], options: TranscriptOptions = DEFAULT_TRANSCRIPT_OPTIONS, missed = false): AcpTextBlock | undefined {
	const { maxCharacters } = options;
	const full = options.detail === 'full';
	const entries: string[] = [];

	// The host's system prompt comes ahead of the first user message, and the role
	// it carries is not reliably `Assistant`, so everything before that message is
	// left out: the agent has a system prompt of its own and must not receive it.
	const firstUser = messages.findIndex(message => message.role === 'user');
	const history = firstUser < 0 ? [] : messages.slice(firstUser);

	for (const message of history) {
		const lines: string[] = [];

		const text = promptTextOf(message).trim();
		if (text.length > 0) {
			lines.push(text);
		}

		const calls = toolCallsOf(message);
		const results = toolResultsOf(message);
		if (full) {
			for (const call of calls) {
				lines.push(`[tool call ${call.name}: ${clip(JSON.stringify(call.input ?? {}), TRANSCRIPT_MAX_TOOL_INPUT_CHARACTERS)}]`);
			}
			for (const result of results) {
				const output = toolResultText(result).trim();
				lines.push(output.length > 0 ? `[tool result: ${clip(output, options.maxToolResultCharacters)}]` : '[tool result: no text]');
			}
		} else {
			if (calls.length > 0) {
				lines.push(`[called tools: ${calls.map(call => call.name).join(', ')}]`);
			}
			if (results.length > 0) {
				lines.push("[tool results omitted]");
			}
		}
		const images = imagePartsOf(message).length;
		if (images > 0) {
			lines.push(`[${images} image(s) omitted]`);
		}

		if (lines.length > 0) {
			const speaker = message.role === 'user' ? "User" : "Assistant";
			entries.push(`${speaker}: ${lines.join('\n')}`);
		}
	}

	const kept: string[] = [];
	let used = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const remaining = maxCharacters - used;
		if (remaining <= 0) {
			break;
		}
		const entry = entries[index];
		// An entry that does not fit keeps its end, where the latest words are.
		const fitted = entry.length > remaining ? `…${entry.slice(entry.length - remaining + 1)}` : entry;
		kept.unshift(fitted);
		used += fitted.length;
	}

	if (kept.length === 0) {
		return undefined;
	}

	return {
		type: 'text',
		text: [
			missed
				? "Since your last turn this conversation went on without you: another assistant answered the messages below. What was said (oldest first; you have no other memory of it):"
				: "This conversation started before your current session did. What was said so far (oldest first; you have no other memory of it):",
			missed ? "<conversation_since_your_last_turn>" : "<conversation_so_far>",
			kept.join('\n\n'),
			missed ? "</conversation_since_your_last_turn>" : "</conversation_so_far>",
			"The user's current message follows. Respond only to it, using the conversation above as context.",
		].join('\n'),
	};
}
