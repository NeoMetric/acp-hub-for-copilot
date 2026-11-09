/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CustomFile, CustomKind } from '../../core/customizations';
import { HOST_IDENTITY } from '../../core/hostIdentity';

/** Room for the required arguments of the tools the chat offers. */
export const TOOL_ARGUMENTS_CHAR_BUDGET = 4_000;
/** Room for the pointers to instruction and prompt files, which the agent reads on demand. */
export const CUSTOM_FILES_CHAR_BUDGET = 10_000;

export interface SessionPromptInput {
	/** Whether the host trusts the workspace; an untrusted one offers none of its files. */
	readonly trusted: boolean;
	/** The folders of the window that sent the request, which a chat with no folders of its own uses. */
	readonly windowFolders: readonly string[];
	/** The sentence telling the agent how the VS Code tools are named and reached. */
	readonly toolAccess: string;
	/** Instruction and prompt files the agent reads when they apply. */
	readonly customFiles?: readonly CustomFile[];
	/** The required arguments of each tool, read from the schema published for it. */
	readonly toolArguments?: readonly ToolArguments[];
	/** The workspace guidance Copilot rendered into its system prompt for this chat. */
	readonly guidance?: string;
}

/** One tool and the arguments its schema marks as required. */
export interface ToolArguments {
	readonly name: string;
	readonly required: readonly string[];
}

/**
 * The folders whose customization files the chat may use, its own winning over
 * the window's; an untrusted workspace offers none, since its files could carry
 * instructions aimed at the agent.
 */
export function sessionFolders(input: Pick<SessionPromptInput, 'trusted' | 'windowFolders'>, chatFolders?: readonly string[]): readonly string[] {
	return input.trusted ? (chatFolders?.length ? [...chatFolders] : input.windowFolders) : [];
}

/**
 * The identity the host's own prompt cannot supply: it names the harness rather
 * than claiming to be it, and keeps the host's rules for the content the model
 * may produce. Everything else the model needs comes from the guidance.
 */
function introOf(toolAccess: string): string {
	return `${HOST_IDENTITY} ${toolAccess} A result of one of these tools can end with a note that the user sent a new message while the tool ran. VS Code adds that note and the words after it are the user's own: treat them as their newest message.

Follow Microsoft content policies. Avoid content that violates copyrights. If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can't assist with that."`;
}

/**
 * The text appended to the agent's own system prompt for one chat. Only what
 * Copilot does not write itself goes in: the required arguments of the tools it
 * publishes, and pointers to the customization files it does not list. The text
 * depends on nothing that changes from turn to turn, so it does not break
 * prompt caching.
 *
 * Skills, custom agents, the text of instruction files and the rules of the
 * memory tool are all left to Copilot: its own system prompt carries them, and
 * that prompt is forwarded untouched.
 */
export function buildSystemPromptAppend(input: SessionPromptInput): string | undefined {
	const sections: string[] = [];
	const carried = scanGuidance(input.guidance);

	if (input.guidance) {
		sections.push(input.guidance);
	}
	const toolArguments = toolArgumentsSection(input.toolArguments);
	if (toolArguments) {
		sections.push(toolArguments);
	}
	sections.push(...customFilesSections(input.customFiles ?? [], carried));

	return sections.length === 0 ? undefined : [introOf(input.toolAccess), ...sections].join('\n\n');
}

/**
 * What the guidance of the host already carries. Copilot writes its index of
 * instruction and prompt files into the system prompt, so a file it names is
 * found by comparing against the text instead of assuming which host rendered
 * it.
 */
interface GuidanceScan {
	readonly text: string;
}

/** Case is folded only where the file system folds it too. */
function squash(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim().replace(/\\/g, '/');
	return process.platform === 'win32' ? collapsed.toLowerCase() : collapsed;
}

function scanGuidance(guidance: string | undefined): GuidanceScan | undefined {
	return guidance === undefined ? undefined : { text: squash(guidance) };
}

/** Whether the guidance already names a file, as a pointer or as an attachment. */
function namesFile(carried: GuidanceScan | undefined, file: string): boolean {
	return carried !== undefined && carried.text.includes(squash(file));
}

const TOOL_ARGUMENTS_HEADER = `## Tool arguments

Copilot runs a tool with whatever arguments the reply carries and does not check them against the tool's schema. Pass every argument the schema marks as required. The required arguments of the tools the chat offers are:

`;

function toolArgumentsSection(tools: readonly ToolArguments[] | undefined): string | undefined {
	const lines: string[] = [];
	let omitted = 0;
	let remaining = TOOL_ARGUMENTS_CHAR_BUDGET;

	// Sorted, so the same tools give the same bytes however Copilot orders them.
	for (const tool of [...tools ?? []].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
		if (tool.required.length === 0) {
			continue;
		}
		const line = `- ${tool.name}: ${tool.required.join(', ')}`;
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
	return `${TOOL_ARGUMENTS_HEADER}\n${lines.join('\n')}`;
}

const CUSTOM_SECTIONS: ReadonlyArray<{ kind: CustomKind; title: string; intro: string }> = [
	{ kind: 'instructions', title: 'Instruction files for specific files', intro: 'Before you work on files that match a pattern below, read that instruction file and follow it. A file with no pattern applies when its description fits the task.' },
	{ kind: 'prompt', title: 'Prompt files', intro: 'The user may refer to one of these by name, for example as `/name`. Read its file and carry it out.' },
];

function customFilesSections(files: readonly CustomFile[], carried: GuidanceScan | undefined): string[] {
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
	return sections;
}

/** The arguments a tool's JSON schema marks as required. */
export function requiredArguments(inputSchema: object | undefined): string[] {
	const required = (inputSchema as { required?: unknown } | undefined)?.required;
	return Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : [];
}
