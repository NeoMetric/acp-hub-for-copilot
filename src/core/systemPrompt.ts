/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as vscode from 'vscode';
import { discoverCustomizations } from './customizations';
import type { Log } from './logging';
import { buildSystemPromptAppend as buildAppend, requiredArguments, sessionFolders, type SessionPromptInput as EngineSessionPromptInput } from '../engine/chat/systemPrompt';

export { TOOL_ARGUMENTS_CHAR_BUDGET, CUSTOM_FILES_CHAR_BUDGET } from '../engine/chat/systemPrompt';
export type { ToolArguments } from '../engine/chat/systemPrompt';

/** What the append is built from: the host read the workspace for the engine, which may not. */
export type SessionPromptInput = Omit<EngineSessionPromptInput, 'trusted' | 'windowFolders'>;

/** What the host knows of its workspace, which the engine is given rather than asking for it. */
function workspaceOf(): Pick<EngineSessionPromptInput, 'trusted' | 'windowFolders'> {
	return {
		trusted: vscode.workspace.isTrusted,
		windowFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
	};
}

export function buildSystemPromptAppend(input: SessionPromptInput): string | undefined {
	return buildAppend({ ...workspaceOf(), ...input });
}

/**
 * Builds what to append for a new chat session from the customization files on
 * disk, honouring the same settings Copilot does. An untrusted workspace
 * contributes nothing, since its files could carry instructions aimed at the
 * agent.
 */
export interface SessionPromptOptions {
	readonly toolAccess: string;
	/** Whether to list the required arguments of each tool in the prompt. */
	readonly listRequiredArguments: boolean;
}

export function createSessionPrompt(log: Log, options: SessionPromptOptions, profilePromptsDir?: string): (tools: readonly vscode.LanguageModelChatTool[], chatFolders?: readonly string[], guidance?: string) => Promise<string | undefined> {
	return async (tools, chatFolders, guidance) => {
		const workspace = workspaceOf();
		// The chat's own folders win over the window's: a window can show a chat of another folder.
		const folders = sessionFolders(workspace, chatFolders);
		const chat = vscode.workspace.getConfiguration('chat');

		const custom = await discoverCustomizations(os.homedir(), folders, {
			profilePromptsDir,
			locations: {
				instructions: chat.get<Record<string, boolean>>('instructionsFilesLocations'),
				prompt: chat.get<Record<string, boolean>>('promptFilesLocations'),
			},
		});
		const toolArguments = options.listRequiredArguments ? tools.map(tool => ({ name: tool.name, required: requiredArguments(tool.inputSchema) })) : undefined;

		const append = buildAppend({ ...workspace, toolAccess: options.toolAccess, customFiles: custom.files, toolArguments, guidance });
		const toolNames = tools.map(tool => tool.name);
		log(`Session prompt: ${custom.files.length} on-demand file(s) found; ${guidance?.length ?? 0} character(s) of host guidance, ${append?.length ?? 0} appended; workspace trusted: ${workspace.trusted}, folders: ${folders.join(', ') || 'none'}; ${toolNames.length} tool(s): ${toolNames.join(', ') || 'none'}.`);
		return append;
	};
}
