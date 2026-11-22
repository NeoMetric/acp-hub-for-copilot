/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { REGISTRY } from '../../core/registry';
import { settingKey, type ConfigReader } from '../../core/settings';
import { TOOL_SERVER_NAME } from '../../core/toolServer';
import type { RegistryAgent } from '../../core/vendors';
import type { AcpPromptSection } from '../http/wire';
import type { CustomFile, CustomKind } from './customizations';

/**
 * The system prompt of a Copilot chat, as the sections the server joins and
 * compares. Everything that depends on how Copilot writes its prompt lives
 * here: the server only sees the sections and their kinds.
 */

/**
 * The one identity sentence every agent gets when its own system prompt is replaced:
 * it names the harness rather than claiming to be it, so it never clashes with a line
 * the agent keeps for itself.
 */
export const HOST_IDENTITY = 'You are running inside Visual Studio Code, as the model behind a chat in GitHub Copilot Chat.';

/** Room for the required arguments of the tools the chat offers. */
export const TOOL_ARGUMENTS_CHAR_BUDGET = 4_000;
/** Room for the pointers to instruction and prompt files, which the agent reads on demand. */
export const CUSTOM_FILES_CHAR_BUDGET = 10_000;

/** The id a host writes into the path of the session folder of a chat. */
const SESSION_FOLDER_ID = /session-state[\\/][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const SESSION_CONTEXT_BLOCK = /<session_context>[\s\S]*?<\/session_context>/g;
/** The line in which Copilot names the mode the chat runs in, and the block that holds its instructions. */
const MODE_LINE = /^You are currently running in "(.+)" mode\./;
const MODE_BLOCK = /<modeInstructions>[\s\S]*?<\/modeInstructions>/g;

function tidy(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Splits the guidance Copilot rendered into the sections the server keeps apart:
 * the guidance every chat of a mode shares, the mode the chat runs in, and what
 * names this chat. The prompt leads the conversation, so one changed character
 * in it makes the model's cache miss for all of it; the host writes the id of
 * the chat's session folder into its guidance, and a prompt that carried it
 * would never be served from the cache for a new chat.
 */
export function copilotSections(guidance: string | undefined): AcpPromptSection[] {
	if (guidance === undefined) {
		return [];
	}
	const chat: string[] = [];
	let rest = guidance.replace(SESSION_CONTEXT_BLOCK, block => {
		chat.push(block);
		return '';
	});
	// A host that writes the folder outside such a block has its line moved on its own.
	rest = rest.split('\n').filter(line => {
		if (!SESSION_FOLDER_ID.test(line)) {
			return true;
		}
		chat.push(line.trim());
		return false;
	}).join('\n');

	const sections: AcpPromptSection[] = [];
	let mode: AcpPromptSection | undefined;
	if (rest.split('\n').some(line => MODE_LINE.test(line.trim()))) {
		const parts: string[] = [];
		let name: string | undefined;
		rest = rest.replace(MODE_BLOCK, block => {
			parts.push(block);
			return '';
		});
		rest = rest.split('\n').filter(line => {
			const found = MODE_LINE.exec(line.trim());
			if (!found) {
				return true;
			}
			name ??= found[1];
			parts.unshift(line.trim());
			return false;
		}).join('\n');
		mode = { id: `mode:${name}`, label: `${name} mode`, text: tidy(parts.join('\n')) };
	}

	sections.push({ id: 'guidance', text: tidy(rest) });
	if (mode) {
		sections.push(mode);
	}
	sections.push({ id: 'chat', kind: 'chat', text: tidy(chat.join('\n\n')) });
	return sections.filter(section => section.text.length > 0);
}

/** The registry entry of an agent or of an account of it, whose id is the agent's followed by the account's name. */
export function registryAgentOf(agentId: string): RegistryAgent | undefined {
	return REGISTRY.agents.find(agent => agent.id === agentId || agentId.startsWith(`${agent.id}-`));
}

/** Whether the user chose to replace the agent's own system prompt; only the boolean `true` counts. */
export function replaceSystemPromptOf(config: ConfigReader, agentId: string): boolean {
	const typeId = registryAgentOf(agentId)?.id ?? agentId;
	return config.get<unknown>(settingKey(typeId, 'replaceSystemPrompt')) === true;
}

/** How the tools of VS Code are reached, and what a note on a tool result means. */
export function notesSection(agentId: string): AcpPromptSection {
	const template = registryAgentOf(agentId)?.mcpToolName;
	const prefix = template?.replace('{server}', TOOL_SERVER_NAME).replace('{tool}', '');
	const access = prefix
		? `The tools whose names start with \`${prefix}\` are VS Code's own and act on the user's workspace.`
		: `The tools of the MCP server named \`${TOOL_SERVER_NAME}\` are VS Code's own and act on the user's workspace.`;
	return {
		id: 'notes',
		kind: 'fixed',
		text: `${HOST_IDENTITY} ${access} A result of one of these tools can end with a note that the user sent a new message while the tool ran. VS Code adds that note and the words after it are the user's own: treat them as their newest message.`,
	};
}

/** Case is folded only where the file system folds it too. */
function squash(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim().replace(/\\/g, '/');
	return process.platform === 'win32' ? collapsed.toLowerCase() : collapsed;
}

/**
 * Whether the guidance already names a file, as a pointer or as an attachment.
 * Copilot writes its index of instruction and prompt files into the system
 * prompt, so a file it names is found by comparing against the text.
 */
function namesFile(carried: string | undefined, file: string): boolean {
	return carried !== undefined && carried.includes(squash(file));
}

const CUSTOM_SECTIONS: ReadonlyArray<{ kind: CustomKind; title: string; intro: string }> = [
	{ kind: 'instructions', title: 'Instruction files for specific files', intro: 'Before you work on files that match a pattern below, read that instruction file and follow it. A file with no pattern applies when its description fits the task.' },
	{ kind: 'prompt', title: 'Prompt files', intro: 'The user may refer to one of these by name, for example as `/name`. Read its file and carry it out.' },
];

/** Pointers to the instruction and prompt files Copilot does not list itself. */
export function instructionFilesSection(files: readonly CustomFile[], guidance: string | undefined): AcpPromptSection | undefined {
	const carried = guidance === undefined ? undefined : squash(guidance);
	const sections: string[] = [];
	let remaining = CUSTOM_FILES_CHAR_BUDGET;

	for (const { kind, title, intro } of CUSTOM_SECTIONS) {
		const lines: string[] = [];
		let omitted = 0;
		for (const item of files.filter(candidate => candidate.kind === kind)) {
			if (namesFile(carried, item.file)) {
				continue;
			}
			const pattern = item.applyTo ? ` [applies to: ${item.applyTo}]` : '';
			const line = `- ${item.name}${pattern}${item.description ? `: ${item.description}` : ''} (${item.file})`;
			if (line.length + 1 > remaining) {
				omitted++;
				continue;
			}
			lines.push(line);
			remaining -= line.length + 1;
		}
		if (omitted > 0) {
			lines.push(`- … ${omitted} more not listed`);
		}
		if (lines.length > 0) {
			sections.push(`## ${title}\n\n${intro}\n\n${lines.join('\n')}`);
		}
	}
	return sections.length === 0 ? undefined : { id: 'instruction-files', kind: 'fixed', text: sections.join('\n\n') };
}

/** A tool as the workbench publishes it: only the arguments its schema marks required matter here. */
export interface PromptTool {
	readonly name: string;
	readonly inputSchema?: unknown;
}

const TOOL_ARGUMENTS_HEADER = `## Tool arguments

Copilot runs a tool with whatever arguments the reply carries and does not check them against the tool's schema. Pass every argument the schema marks as required. The required arguments of the tools the chat offers are:

`;

/** The arguments a tool's JSON schema marks as required. */
function requiredArguments(inputSchema: unknown): string[] {
	const required = (inputSchema as { required?: unknown } | undefined)?.required;
	return Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : [];
}

export function toolArgumentsSection(tools: readonly PromptTool[]): AcpPromptSection | undefined {
	const lines: string[] = [];
	let omitted = 0;
	let remaining = TOOL_ARGUMENTS_CHAR_BUDGET;

	// Sorted, so the same tools give the same bytes however Copilot orders them.
	for (const tool of [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
		const required = requiredArguments(tool.inputSchema);
		if (required.length === 0) {
			continue;
		}
		const line = `- ${tool.name}: ${required.join(', ')}`;
		if (line.length + 1 > remaining) {
			omitted++;
			continue;
		}
		lines.push(line);
		remaining -= line.length + 1;
	}
	if (lines.length === 0) {
		return undefined;
	}
	if (omitted > 0) {
		lines.push(`- … ${omitted} more tool${omitted === 1 ? '' : 's'} not listed`);
	}
	return { id: 'tool-arguments', kind: 'fixed', text: `${TOOL_ARGUMENTS_HEADER}\n${lines.join('\n')}` };
}

/**
 * Every section of the prompt of one chat, or `undefined` when Copilot gave
 * none and there is nothing to add. The order is fixed, and the sections that
 * follow the tools a chat offers come last, so a prompt cached by prefix is
 * lost only from there on.
 */
export function promptSectionsOf(input: {
	readonly agentId: string;
	readonly guidance: string | undefined;
	readonly files: readonly CustomFile[];
	readonly tools: readonly PromptTool[];
}): AcpPromptSection[] | undefined {
	const copilot = copilotSections(input.guidance);
	// The chat section names this chat alone, so what it mentions must not change which files are listed.
	const shared = copilot.filter(section => section.kind !== 'chat').map(section => section.text).join('\n\n');
	const files = instructionFilesSection(input.files, input.guidance === undefined ? undefined : shared);
	const toolArguments = registryAgentOf(input.agentId)?.listRequiredArguments ? toolArgumentsSection(input.tools) : undefined;
	if (copilot.length === 0 && !files && !toolArguments) {
		return undefined;
	}
	return [
		notesSection(input.agentId),
		...copilot.filter(section => section.kind !== 'chat'),
		...(files ? [files] : []),
		...(toolArguments ? [toolArguments] : []),
		...copilot.filter(section => section.kind === 'chat'),
	];
}
