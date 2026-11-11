/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, ChatRequest, Part, ToolResult } from '../model/chat';
import type { ConfigReader, SecretStore, StateStore } from './state';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Writes one message to the host's output; the level defaults to `info`. */
export type Log = (message: string, level?: LogLevel) => void;

/** Where a chat lives and what it may see: the engine's stand-in for a workspace. */
export interface ChatIdentity {
	readonly id: string;
	readonly cwd: string;
	readonly workspaceFolders: readonly string[];
	/** The opening words of the chat, when the host can name it. */
	readonly label?: string;
	/**
	 * Whose chat it is: the host's own client identity, which quotas are counted
	 * per. The VS Code host names its window; the server names the authenticated
	 * principal. A host that names nobody is {@link DEFAULT_CHAT_OWNER}.
	 */
	readonly owner?: string;
}

/** The owner of a chat whose host names no client, such as a server without a token. */
export const DEFAULT_CHAT_OWNER = 'default';

/** A tool call a host is asked to run. */
export type ToolCall = Extract<Part, { readonly type: 'tool-call' }>;

/** What a host may show the user; the engine never assumes a particular UI. */
export interface HostUi {
	/** Opens the host's sign-in for the agent. */
	requestSignIn(agentId: string): void;
	/** Shows a message with optional action labels, and resolves to the label the user picked. */
	notify(message: string, actions?: readonly string[]): Promise<string | undefined>;
	/** Opens a URL in the user's browser. */
	openExternal(url: string): Promise<void>;
}

/**
 * Everything the engine may ask of the host it runs in. Nothing else of the
 * host is reachable from the engine, which is what lets a second host reuse it.
 */
export interface HostPort {
	readonly log: Log;
	readonly state: StateStore;
	readonly secrets: SecretStore;
	readonly settings: ConfigReader;
	/** The folder the agents are installed in and keep their state in. */
	readonly storageRoot: string;
	/** Which chat the request belongs to, and the folders of the window that sent it. */
	chatIdentity(request: ChatRequest): ChatIdentity;
	/** The workspace guidance the host wrote into the request, if any. */
	guidanceOf(request: ChatRequest): string | undefined;
	/**
	 * Takes the host's own sections out of text the engine forwards. The engine
	 * knows no section of any host's prompt, so it asks this instead of naming
	 * them; a host whose prompt has none hands the text back as it is.
	 */
	stripHostSections(text: string): string;
	/**
	 * The context the host holds for the chat as a whole — its environment, the
	 * layout of its workspace, the memory it loaded — read from the messages that
	 * come before the turn's first request. The engine forwards it once, when a
	 * session starts; the agent has no other way to see it.
	 */
	chatWideContextOf(messages: readonly ChatMessage[]): string | undefined;
	/** Runs one tool call the agent made and resolves with its result. */
	executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
	readonly ui: HostUi;
	/** Republishes the models of `vendor`; the VS Code workbench supplies it, other hosts need not. */
	publishModels?(vendor: string): Promise<void>;
}
