/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { AgentAdapter, LastModelCall, LaunchContext } from '../adapter';
import type { AcpTokenUsage, AgentClient, AgentClientDeps, AgentSession, PromptResult } from '../agentClient';
import type { McpBridge, McpServerEndpoint } from '../bridge';
import type { ChatIdentity } from '../cache';
import type { Log } from '../logging';
import type { Checkpoint, SavedSession } from '../sessionStore';
import type { AgentMessage } from './checkpoints';

/** The part of {@link AgentClient} the provider uses; tests hand in a fake. */
export type AgentApi = Pick<AgentClient,
	'ensureStarted' | 'createSession' | 'resumeSession' | 'forkSession' | 'deleteSession' | 'supportsFork' | 'supportsDelete' | 'closeSession' | 'setConfigOption' | 'setSessionModel'
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
	/** Characters of thinking text the agent streamed this turn. */
	thoughtCharacters?: number;
	/** Token counts of the last model call, as reported by the agent. */
	contextUsed?: number;
	contextSize?: number;
	/** The last model call the agent made, for an agent whose protocol reports only the turn's sums. */
	lastCall?: LastModelCall;
	/** Token counts of the model calls this turn has made so far, added up (agents that report each call). */
	requestUsage?: AcpTokenUsage;
	/** Model calls seen through `usage_update` and the tokens they sent, added up (agents that report only the turn's cache split). */
	contextCalls: number;
	contextSent: number;
	/** What the agent said this turn, message by message, for the checkpoint the turn leaves. */
	readonly agentMessages: AgentMessage[];
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
	/** The mode the agent was in until now, when the guidance no longer puts it there. */
	readonly leftMode?: string;
	/** The text of the lines that are gone, apart from those of the mode that was left; known only when the earlier guidance is. */
	readonly goneLines?: readonly string[];
}

/** A stored conversation that a request can continue instead of starting over. */
export interface Reuse {
	readonly kind: 'resume' | 'fork';
	readonly saved: SavedSession;
	/** Where a fork is taken; a fork without one copies the saved session up to its latest message. */
	readonly checkpoint?: Checkpoint;
	/** Set when the chat resumes its own session although the guidance differs; the change is sent with the next prompt. */
	readonly guidanceChange?: GuidanceChange;
	/** The messages of the request that the stored conversation already holds. */
	readonly history: readonly string[];
}

export interface ChatSession {
	readonly acp: AgentSession;
	readonly endpoint: McpServerEndpoint;
	/** The guidance in it is what the agent has been told, so it follows the guidance changes sent to the session. */
	context: ChatContext;
	readonly history: string[];
	/** The ends of the turns the session holds, which a later request can fork from. */
	checkpoints: Checkpoint[];
	/** How often each agent message text occurs in the session, to number the occurrences in a fork point. */
	readonly messageCounts: Map<string, number>;
	/** Whether the extension made the session by forking, which lets it delete the session when its entry expires. */
	forked?: boolean;
	model: string;
	/** How many tools Copilot offered with the latest request; none marks a request Copilot made for itself. */
	toolCount: number;
	/** The tool names the session's bridge serves now, with the hash saved for them. */
	openedTools: ReadonlySet<string>;
	/** Whether the session was given the workspace prompt; a request that offers no tools gets none. */
	readonly hasPrompt: boolean;
	/** Hashes of what the session opened with, saved so a later window can tell whether it may pick the session up again. */
	toolsHash: string;
	guidanceHash: string;
	readonly promptHash: string;
	/** Hash of the user and mode instructions the agent was last given, so each change is sent once. */
	instructionsHash?: string;
	/** Guidance the session has not been told about yet, because it was resumed or Copilot changed it since; the next prompt carries it. */
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
