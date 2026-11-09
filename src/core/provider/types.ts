/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { AgentAdapter, LaunchContext } from '../adapter';
import type { AgentClientDeps } from '../../engine/acp/agentClient';
import type { McpBridge } from '../bridge';
import type { Log } from '../logging';
import type { AgentApi } from '../../engine/chat/types';

/** The chat types live in the engine now; every existing import site keeps working. */
export type { AgentApi, ActiveTurn, ChatContext, ChatSession, FinishedTurn, GuidanceChange, HeldToolCall, PendingToolCall, Reuse } from '../../engine/chat/types';

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

