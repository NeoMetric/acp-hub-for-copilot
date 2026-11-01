/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { AgentAdapter, LaunchContext } from '../adapter';
import type { AcpTokenUsage, AgentClient, AgentClientDeps, AgentSession, PromptResult } from '../agentClient';
import type { McpBridge, McpServerEndpoint } from '../bridge';
import type { ChatIdentity } from '../cache';
import type { Log } from '../logging';
import type { SavedSession } from '../sessionStore';

/** The part of {@link AgentClient} the provider uses; tests hand in a fake. */
export type AgentApi = Pick<AgentClient,
	'ensureStarted' | 'createSession' | 'resumeSession' | 'forkSession' | 'closeSession' | 'setConfigOption' | 'setSessionModel'
	| 'prompt' | 'cancel' | 'restart' | 'stopWhenIdle' | 'hasBackgroundTasks' | 'isRunning' | 'requiresSignIn' | 'onDidChange'
	| 'updateContext' | 'signInWithMethod' | 'dispose'>;

/** Everything the provider needs from the extension that hosts it. */
export interface ProviderDeps {
	log: Log;
	bridge: McpBridge;
	/** Extension state; the model list and the saved sessions live in it, keyed by agent. */
	state: vscode.Memento | undefined;
	/** The launch context of the installed agent, or `undefined` when it is not installed. */
	resolveLaunch(): Promise<LaunchContext | undefined>;
	isEnabled?(): boolean;
	/** What the agent client needs besides the launch context. */
	client: AgentClientDeps;
	/** Folder for the request dumps; they are written only when the agent's `dumpRequests` setting is on. */
	requestDumpDir?: vscode.Uri;
	/** The user's profile folder with prompt files, read by the session prompt. */
	profilePromptsDir?: string;
	/** Opens the sign-in for the agent (the sidebar's sign-in). */
	signIn(agentId: string): void;
	showOutput(): void;
	/** Replaces the real client; tests use it to run the provider over a fake. */
	createClient?(adapter: AgentAdapter, ctx: LaunchContext, deps: AgentClientDeps): AgentApi;
}

/** One tool call handed to Copilot, settled when its result comes back. */
export interface PendingToolCall {
	readonly resolve: (content: ReadonlyArray<unknown>, isError: boolean) => void;
	readonly reject: (error: Error) => void;
}

/** A tool call that arrived between two responses, waiting for the next one. */
export interface HeldToolCall extends PendingToolCall {
	readonly callId: string;
	readonly name: string;
	readonly input: object;
}

/**
 * One ACP turn. A turn can outlive a single provider request: when the agent
 * calls a tool, the response ends so Copilot runs the tool, and the next
 * request carrying the tool result continues the same turn.
 */
export interface ActiveTurn {
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	prompt: Promise<PromptResult>;
	readonly sessionId: string;
	result?: PromptResult;
	error?: unknown;
	finished: boolean;
	/** False once the current response returned; late output has nowhere to go. */
	streaming: boolean;
	readonly pending: Map<string, PendingToolCall>;
	/** Calls the agent made while no response was open; the next response carries them. */
	readonly held: HeldToolCall[];
	/** Cancellations of every request that carried the turn, disposed with it. */
	readonly cancellations: vscode.Disposable[];
	/** Fails the tool calls no response picked up in time. */
	toolDeadline?: NodeJS.Timeout;
	waiters: Array<() => void>;
	toolCalls: number;
	characters: number;
	/** Token counts of the last model call, as reported by the agent. */
	contextUsed?: number;
	contextSize?: number;
	/** Token counts of the model calls this turn has made so far, added up (agents that report each call). */
	requestUsage?: AcpTokenUsage;
	/** Completion tokens already reported to Copilot. */
	reportedTokens: number;
	startedAt: number;
}

/** The workspace a chat belongs to, which can differ from the one the window has open. */
export interface ChatContext {
	/** The folders Copilot rendered into the chat, when it rendered any. */
	readonly folders: readonly string[] | undefined;
	/** Where the agent is rooted. */
	readonly cwd: string;
	/** The workspace guidance Copilot rendered into the system message of the request. */
	readonly guidance: string | undefined;
}

/** How the guidance of a chat differs from the one its saved session was given. */
export interface GuidanceChange {
	/** Lines the saved session never saw. */
	readonly added: readonly string[];
	/** How many lines it saw that are gone. */
	readonly removed: number;
}

/** A stored conversation that a request can continue instead of starting over. */
export interface Reuse {
	readonly kind: 'resume' | 'fork';
	readonly saved: SavedSession;
	/** Set when the chat resumes its own session although the guidance differs; the change is sent with the next prompt. */
	readonly guidanceChange?: GuidanceChange;
	/** The messages of the request that the stored conversation already holds. */
	readonly history: readonly string[];
}

export interface ChatSession {
	readonly acp: AgentSession;
	readonly endpoint: McpServerEndpoint;
	readonly context: ChatContext;
	readonly history: string[];
	model: string;
	/** How many tools Copilot offered with the latest request; none marks a request Copilot made for itself. */
	toolCount: number;
	/** Every tool name this session has been offered, so a newly offered tool starts a session that can see it. */
	readonly openedTools: ReadonlySet<string>;
	/** Whether the session was given the workspace prompt; a request that offers no tools gets none. */
	readonly hasPrompt: boolean;
	/** Hashes of what the session opened with, saved so a later window can tell whether it may pick the session up again. */
	readonly toolsHash: string;
	readonly guidanceHash: string;
	readonly promptHash: string;
	/** Hash of the user and mode instructions the agent was last given, so each change is sent once. */
	instructionsHash?: string;
	/** Guidance the resumed session has not been told about yet; the next prompt carries it. */
	guidanceChange?: GuidanceChange;
	/** Set when the session continues a stored conversation. Its first model call logs whether the cache served it. */
	reused?: { readonly how: 'resumed' | 'forked'; readonly from: string; logged: boolean };
	/** How the chat is listed by whoever shows per-chat figures. */
	chat?: ChatIdentity;
	/** Failed turns in a row, so a session that keeps failing is replaced instead of kept forever. */
	failures: number;
	/** When the chat last asked for something or finished a turn; a session idle for long enough is released. */
	lastActive: number;
	/** The `model|effort` pair the agent already refused, so the warning is said once. */
	effortFailure?: string;
	/** The context the agent last reported; some agents report it only after they started the tools of a call, so the first response of a turn would otherwise report none. */
	contextUsed?: number;
	turn?: ActiveTurn;
}

/** A finished chat turn. */
export interface FinishedTurn {
	readonly usage: AcpTokenUsage | undefined;
	/** Whether Copilot made the request for its own purposes, such as a chat title, which it does without offering tools. */
	readonly background: boolean;
	/** The chat the turn belongs to. */
	readonly chat?: ChatIdentity;
	readonly model: string;
	/** What the agent last reported about its context window. */
	readonly contextUsed?: number;
	readonly contextSize?: number;
}
