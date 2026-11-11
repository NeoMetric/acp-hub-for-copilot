/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import { discoverCustomizations, type CustomKind } from './customizations';
import type { Log } from './logging';
import {
	buildSystemPromptAppend,
	CUSTOM_FILES_CHAR_BUDGET,
	requiredArguments,
	sessionFolders,
	TOOL_ARGUMENTS_CHAR_BUDGET,
	type SessionPromptInput as EngineSessionPromptInput,
	type ToolArguments,
} from '../engine/chat/systemPrompt';

export { buildSystemPromptAppend, CUSTOM_FILES_CHAR_BUDGET, TOOL_ARGUMENTS_CHAR_BUDGET };
export type { ToolArguments };

/** What the append is built from: everything but the workspace, which decides the files offered. */
export type SessionPromptInput = Omit<EngineSessionPromptInput, 'trusted' | 'windowFolders'>;

/**
 * What the host knows of the folders a chat draws its customization files from,
 * which the engine is given rather than asking for. A server has no window, so
 * it reports the folders it was configured to serve.
 */
export interface PromptWorkspace {
	/** An untrusted workspace contributes nothing, since its files could carry instructions aimed at the agent. */
	readonly trusted: boolean;
	/** The folders the host serves, which a chat with no folders of its own uses. */
	readonly windowFolders: readonly string[];
	/** The host's own instruction and prompt file locations, where it has such settings. */
	readonly locations?: Partial<Record<CustomKind, Record<string, boolean> | undefined>>;
}

/** A tool as a host publishes it: the prompt only needs the arguments its schema marks required. */
export interface PromptTool {
	readonly name: string;
	readonly inputSchema?: unknown;
}

/** The two sentences of the session prompt an agent's adapter decides. */
export interface SessionPromptOptions {
	readonly toolAccess: string;
	/** Whether to list the required arguments of each tool in the prompt. */
	readonly listRequiredArguments: boolean;
}

/**
 * Builds what to append for a new chat session from the customization files on
 * disk, honouring the same settings Copilot does. The host's workspace is read
 * on each call, so a request that names other folders is honoured. An untrusted
 * workspace contributes nothing, since its files could carry instructions aimed
 * at the agent.
 */
export function createSessionPrompt(log: Log, options: SessionPromptOptions, workspaceOf: () => PromptWorkspace, promptsDir?: string): (tools: readonly PromptTool[], chatFolders?: readonly string[], guidance?: string) => Promise<string | undefined> {
	return async (tools, chatFolders, guidance) => {
		const workspace = workspaceOf();
		// The chat's own folders win over the window's: a window can show a chat of another folder.
		const folders = sessionFolders(workspace, chatFolders);

		const custom = await discoverCustomizations(os.homedir(), folders, {
			profilePromptsDir: promptsDir,
			locations: workspace.locations,
		});
		const toolArguments = options.listRequiredArguments ? tools.map(tool => ({ name: tool.name, required: requiredArguments(tool.inputSchema) })) : undefined;

		const append = buildSystemPromptAppend({ toolAccess: options.toolAccess, customFiles: custom.files, toolArguments, guidance });
		const toolNames = tools.map(tool => tool.name);
		log(`Session prompt: ${custom.files.length} on-demand file(s) found; ${guidance?.length ?? 0} character(s) of host guidance, ${append?.length ?? 0} appended; workspace trusted: ${workspace.trusted}, folders: ${folders.join(', ') || 'none'}; ${toolNames.length} tool(s): ${toolNames.join(', ') || 'none'}.`);
		return append;
	};
}
