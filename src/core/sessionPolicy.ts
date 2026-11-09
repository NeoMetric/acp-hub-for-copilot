/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter, AgentSettings, ConversationForker } from './adapter';
import { nativeSessionPolicy } from './nativeSessionPolicy';
import type { SavedSession } from '../engine/chat/sessionStore';

/** A chat's agent session that is open now, for a policy that must know whether the saved conversation is in use or mid-turn. */
export interface LiveSessionInfo {
	readonly chatKey: string;
	readonly sessionId: string;
	readonly hasTurn: boolean;
}

/** Everything a policy may weigh when a request can continue a stored conversation instead of starting over. */
export interface ContinuationInput {
	readonly saved: SavedSession;
	readonly live: readonly LiveSessionInfo[];
	/** Whether the chat edited one of its own messages, so it leaves the turns after that point behind. */
	readonly editedOwnChat: boolean;
	/** Whether the running agent said in `initialize` that it answers `session/fork`. */
	readonly agentSupportsFork: boolean;
	/** The program the adapter forks with when the agent cannot, where this machine has one. */
	readonly externalForker: ConversationForker | undefined;
}

/**
 * What the core should do with a stored conversation. `fork-external` carries what the adapter's
 * forker needs to know: whether the fork may keep the source's id, so its prompt cache still serves
 * the conversation, and whether the agent must be restarted before the copy is opened.
 */
export type ContinuationPlan =
	| { readonly how: 'resume' }
	| { readonly how: 'fork-native' }
	| { readonly how: 'fork-external'; readonly keepSourceId: boolean; readonly restartFirst: boolean }
	| { readonly how: 'rebuild' };

/** What a policy may weigh when it decides whether a stored conversation can be continued by forking. */
export interface CanForkInput {
	/** Whether the running agent said in `initialize` that it answers `session/fork`. */
	readonly agentSupportsFork: boolean;
}

/** The prompt to open a session with: the one the stored session began with, or the one the core rebuilt. */
export interface OpenPromptInput {
	/** The prompt the stored session was opened with, when it is known. */
	readonly savedPrompt: string | undefined;
	/** The prompt rebuilt from the current guidance and tools. */
	readonly rebuilt: string | undefined;
}

/**
 * How one agent continues a stored conversation, whether a chat may fork it, what its chats do when
 * the offered tools change, and how long a tool call may wait: every decision the core used to read
 * from a flag on the adapter. The core owns the execution; the adapter owns the choice.
 */
export interface SessionPolicy {
	/** How a request that can continue `input.saved` instead of starting over goes on. */
	planContinuation(input: ContinuationInput): ContinuationPlan;
	/** Whether a chat may continue a stored conversation by forking it at all. */
	canFork(input: CanForkInput): boolean;
	/** The session prompt to open with, chosen from the saved prompt and the one the core rebuilt. */
	promptForOpen(input: OpenPromptInput): string | undefined;
	/** Whether opening a store-backed session must be given the prompt it was saved with. */
	readonly keepsSavedPrompt: boolean;
	/** What a chat whose offered tools changed needs: `list-changed` for an agent that fetches the list again, `reopen` for one that reads it only on opening. */
	toolsChangedAction(): 'reopen' | 'list-changed';
	/** How long (ms) a tool call may wait for Copilot to pick it up. */
	toolWaitMs(settings: AgentSettings): number;
}

/** The policy an adapter runs under: its own, or the native default it inherits by declaring none. */
export function policyOf(adapter: AgentAdapter): SessionPolicy {
	return adapter.sessionPolicy ?? nativeSessionPolicy;
}

/** The wait a tool call gets when the policy names one the core cannot use: one day, so a lost result fails the call instead of hanging the chat. */
export const DEFAULT_TOOL_WAIT_MS = 24 * 60 * 60_000;

/**
 * The wait a tool call gets from the policy. A policy that names no wait at all leaves it unbounded, as an
 * adapter that named no timeout always did; a wait that is zero, negative or not a number is the default, so
 * a lost tool result fails the call rather than hanging the chat.
 */
export function effectiveToolWaitMs(policy: SessionPolicy, settings: AgentSettings): number {
	const ms = policy.toolWaitMs(settings);
	if (ms === Number.POSITIVE_INFINITY) {
		return ms;
	}
	return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TOOL_WAIT_MS;
}
