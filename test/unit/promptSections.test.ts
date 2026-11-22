/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcpPromptSection } from '../../src/hosts/http/wire';
import type { CustomFile } from '../../src/hosts/vscode/customizations';
import { systemGuidanceOf } from '../../src/hosts/vscode/identity';
import { PromptFiles } from '../../src/hosts/vscode/promptFiles';
import {
	copilotSections,
	CUSTOM_FILES_CHAR_BUDGET,
	instructionFilesSection,
	notesSection,
	promptSectionsOf,
	registryAgentOf,
	replaceSystemPromptOf,
	toolArgumentsSection,
} from '../../src/hosts/vscode/promptSections';
import { system } from './messages';

const file = (kind: 'instructions' | 'prompt', name: string, extra: { applyTo?: string; description?: string } = {}): CustomFile =>
	({ kind, name, description: extra.description ?? '', file: `/c/${name}`, applyTo: extra.applyTo });

const hostPrompt = (extra = '') => [
	'You are an expert AI programming assistant, working with a user in the VS Code editor.',
	'Your name is GitHub Copilot.',
	'Follow Microsoft content policies.',
	'Keep your answers short and impersonal.',
	'<environment_context>',
	'* Current working directory: c:\\repo',
	'</environment_context>',
	'<available_skills><skill><name>review</name></skill></available_skills>',
	extra,
].join('\n');

const sessionBlock = (id: string) => `<session_context>\nSession folder: c:/Users/me/.copilot/session-state/${id}\n</session_context>`;
const ID_ONE = '11111111-2222-3333-4444-555555555555';
const ID_TWO = '66666666-7777-8888-9999-aaaaaaaaaaaa';

const textOf = (sections: readonly AcpPromptSection[] | undefined) => (sections ?? []).map(section => section.text).join('\n\n');

describe('the prompt of a replaced system prompt', () => {
	const sectionsFor = (replace: boolean) => promptSectionsOf({
		agentId: 'claude',
		guidance: systemGuidanceOf([system(hostPrompt())], { keepIdentity: replace }),
		files: [],
		tools: [],
	});

	it("keeps Copilot's identity and content policy when the prompt is replaced", () => {
		const kept = textOf(sectionsFor(true));
		const dropped = textOf(sectionsFor(false));

		for (const line of ['You are an expert AI programming assistant', 'Your name is GitHub Copilot.', 'Follow Microsoft content policies.']) {
			expect(kept).toContain(line);
			expect(dropped).not.toContain(line);
		}
		expect(dropped).toContain('<environment_context>');
		expect(dropped).toContain('<available_skills>');
	});
});

describe('notesSection', () => {
	it('adds the tool notes in both modes', () => {
		for (const [agent, prefix] of [['claude', 'mcp__hub__'], ['codex', 'mcp__hub__'], ['google', 'mcp_hub_']] as const) {
			const notes = notesSection(agent).text;

			expect(notes).toContain(`\`${prefix}\``);
			expect(notes).toContain('VS Code adds that note');
			expect(notes).toContain('You are running inside Visual Studio Code');
			expect(promptSectionsOf({ agentId: agent, guidance: 'g', files: [], tools: [] })![0]).toEqual(notesSection(agent));
		}
	});

	it('names the server for an agent with no tool name template', () => {
		expect(notesSection('unknown').text).toContain("The tools of the MCP server named `hub` are VS Code's own and act on the user's workspace.");
	});
});

describe('copilotSections', () => {
	it('gives two chats identical sections apart from the chat section', () => {
		for (const agentId of ['claude', 'google']) {
			for (const replace of [true, false]) {
				const build = (id: string) => promptSectionsOf({
					agentId,
					guidance: systemGuidanceOf([system(`${hostPrompt()}\n${sessionBlock(id)}`)], { keepIdentity: replace }),
					files: [file('instructions', 'ts', { applyTo: '**/*.ts' })],
					tools: [{ name: 'view', inputSchema: { required: ['path'] } }],
				})!;
				const [one, two] = [build(ID_ONE), build(ID_TWO)];

				expect(one.filter(section => section.id !== 'chat')).toEqual(two.filter(section => section.id !== 'chat'));
				expect(one.at(-1)).toMatchObject({ id: 'chat', kind: 'chat' });
				expect(one.at(-1)!.text).toContain(ID_ONE);
				expect(two.at(-1)!.text).toContain(ID_TWO);
				expect(textOf(one.filter(section => section.id !== 'chat'))).not.toContain('session-state');
			}
		}
	});

	it('moves a session folder line written outside a session block to the chat section', () => {
		const sections = copilotSections(`rules\nSession folder: /home/me/.copilot/session-state/${ID_ONE}\nmore rules`);

		expect(sections.map(section => section.id)).toEqual(['guidance', 'chat']);
		expect(sections[0].text).toBe('rules\nmore rules');
		expect(sections[1].text).toContain(ID_ONE);
	});

	it('moves a session folder line with backslashes to the chat section', () => {
		const sections = copilotSections(`rules\nSession folder: C:\\Users\\me\\.copilot\\session-state\\${ID_ONE}\nmore rules`);

		expect(sections.map(section => section.id)).toEqual(['guidance', 'chat']);
		expect(sections[0].text).toBe('rules\nmore rules');
		expect(sections[1].text).toContain(ID_ONE);
	});

	it('lists the same files in every chat, whatever a chat names in its own block', () => {
		const files = [file('instructions', 'ts', { applyTo: '**/*.ts' })];
		const build = (chatText: string) => promptSectionsOf({
			agentId: 'claude',
			guidance: `${hostPrompt()}\n<session_context>\n${chatText}\n</session_context>`,
			files,
			tools: [],
		})!;
		const [naming, plain] = [build(`Plan: /c/ts ${ID_ONE}`), build(`Plan: none ${ID_TWO}`)];

		expect(naming.find(section => section.id === 'instruction-files')).toBeDefined();
		expect(naming.filter(section => section.id !== 'chat')).toEqual(plain.filter(section => section.id !== 'chat'));
	});

	it('splits the mode into a labelled section after the guidance', () => {
		const sections = copilotSections('Rules.\nYou are currently running in "Agent" mode.\n<modeInstructions>x</modeInstructions>\nMore rules.');

		expect(sections.map(section => section.id)).toEqual(['guidance', 'mode:Agent']);
		expect(sections[1]).toEqual({ id: 'mode:Agent', label: 'Agent mode', text: 'You are currently running in "Agent" mode.\n<modeInstructions>x</modeInstructions>' });
		expect(sections[0].text).toBe('Rules.\n\nMore rules.');
		expect(sections[0].text).not.toContain('modeInstructions');
		expect(sections[0].text).not.toContain('currently running');
	});

	it('has no mode section when the guidance names no mode', () => {
		const sections = copilotSections('Rules.\n<modeInstructions>x</modeInstructions>');

		expect(sections.map(section => section.id)).toEqual(['guidance']);
	});

	it('gives no sections for no guidance', () => {
		expect(copilotSections(undefined)).toEqual([]);
	});
});

describe('toolArgumentsSection', () => {
	const tools = [
		{ name: 'powershell', inputSchema: { required: ['command', 'description'] } },
		{ name: 'view', inputSchema: { required: ['path'] } },
		{ name: 'glob', inputSchema: {} },
	];

	it('lists required tool arguments only for an agent that needs them, in name order', () => {
		const shuffled = [tools[1], tools[2], tools[0]];
		const input = { guidance: 'g', files: [] };

		const first = promptSectionsOf({ agentId: 'google', ...input, tools })!.find(section => section.id === 'tool-arguments')!;
		const second = promptSectionsOf({ agentId: 'google', ...input, tools: shuffled })!.find(section => section.id === 'tool-arguments')!;

		expect(second.text).toBe(first.text);
		expect(first.text.indexOf('- powershell: command, description')).toBeLessThan(first.text.indexOf('- view: path'));
		expect(first.text).not.toContain('- glob:');
		expect(promptSectionsOf({ agentId: 'claude', ...input, tools })!.some(section => section.id === 'tool-arguments')).toBe(false);
	});

	it('adds nothing when no tool requires an argument', () => {
		expect(toolArgumentsSection([{ name: 'view', inputSchema: { required: [] } }])).toBeUndefined();
	});

	it('stops at its budget and says how many tools it left out', () => {
		const many = Array.from({ length: 500 }, (_, index) => ({ name: `tool-${String(index).padStart(3, '0')}`, inputSchema: { required: ['argument-name'.repeat(3)] } }));

		const text = toolArgumentsSection(many)!.text;

		expect(text).toContain('- tool-000:');
		expect(text).not.toContain('- tool-499:');
		expect(text).toMatch(/- … \d+ more tools not listed/);
	});
});

describe('promptSectionsOf', () => {
	it('marks notes, instruction files and tool arguments as fixed', () => {
		const sections = promptSectionsOf({
			agentId: 'google',
			guidance: `Rules.\n${sessionBlock(ID_ONE)}`,
			files: [file('instructions', 'ts', { applyTo: '**/*.ts' })],
			tools: [{ name: 'view', inputSchema: { required: ['path'] } }],
		})!;

		expect(sections.map(section => `${section.id}:${section.kind ?? ''}`)).toEqual([
			'notes:fixed', 'guidance:', 'instruction-files:fixed', 'tool-arguments:fixed', 'chat:chat',
		]);
	});

	it('gives nothing when there is no guidance, no file and no tool argument', () => {
		expect(promptSectionsOf({ agentId: 'claude', guidance: undefined, files: [], tools: [] })).toBeUndefined();
		expect(promptSectionsOf({ agentId: 'google', guidance: undefined, files: [], tools: [{ name: 'view' }] })).toBeUndefined();
	});

	it('is identical for identical input, so prompt caching holds', () => {
		const input = { agentId: 'claude', guidance: '<context>Go.</context>', files: [file('instructions', 'ts', { applyTo: '**/*.ts' })], tools: [] };

		expect(JSON.stringify(promptSectionsOf(input))).toBe(JSON.stringify(promptSectionsOf({ ...input })));
	});
});

describe('instructionFilesSection', () => {
	it('lists instruction and prompt files in their own parts', () => {
		const text = instructionFilesSection([file('instructions', 'ts', { applyTo: '**/*.ts', description: 'TypeScript rules' }), file('prompt', 'ship')], undefined)!.text;

		expect(text).toContain('## Instruction files for specific files');
		expect(text).toContain('- ts [applies to: **/*.ts]: TypeScript rules (/c/ts)');
		expect(text).toContain('## Prompt files');
		expect(text).toContain('- ship (/c/ship)');
	});

	it('lists the instruction files in a fixed order', () => {
		const files = [file('instructions', 'a', { applyTo: '*.a' }), file('instructions', 'b', { applyTo: '*.b' }), file('prompt', 'p')];

		expect(instructionFilesSection(files, 'g')).toEqual(instructionFilesSection([...files], 'g'));
	});

	it('does not repeat a file the guidance already names, so nothing is paid for twice', () => {
		const section = instructionFilesSection([file('instructions', 'ts', { applyTo: '**/*.ts' })], '<instructions><instruction><file>/c/ts</file></instruction></instructions>');

		expect(section).toBeUndefined();
	});

	it('lists a file the guidance does not name', () => {
		const text = instructionFilesSection([file('instructions', 'ts', { applyTo: '**/*.ts' })], '<code_change_instructions>Make precise, surgical changes.</code_change_instructions>')!.text;

		expect(text).toContain('- ts [applies to: **/*.ts] (/c/ts)');
	});

	it('stops listing files at the budget', () => {
		const many = Array.from({ length: 500 }, (_, index) => file('prompt', `p-${String(index).padStart(3, '0')}`, { description: 'x'.repeat(200) }));

		const text = instructionFilesSection(many, undefined)!.text;
		const section = text.slice(text.indexOf('## Prompt files'));

		expect(section.length).toBeLessThanOrEqual(CUSTOM_FILES_CHAR_BUDGET + 1000);
		expect(section).toContain('- p-000:');
		expect(section).not.toContain('- p-499:');
		expect(section).toMatch(/- … \d+ more not listed/);
	});
});

describe('the replace setting', () => {
	const configOf = (values: Record<string, unknown>) => ({ get: <T>(section: string) => values[section] as T | undefined });

	it('reads the replace setting of the agent type for an extra account', () => {
		const config = configOf({ 'agents.claude.replaceSystemPrompt': true });

		expect(replaceSystemPromptOf(config, 'claude-work')).toBe(true);
		expect(replaceSystemPromptOf(config, 'claude')).toBe(true);
		expect(replaceSystemPromptOf(config, 'google')).toBe(false);
		expect(registryAgentOf('claude-work')?.id).toBe('claude');
	});

	it('treats a missing or non-boolean replace setting as off', () => {
		expect(replaceSystemPromptOf(configOf({}), 'claude')).toBe(false);
		expect(replaceSystemPromptOf(configOf({ 'agents.claude.replaceSystemPrompt': 'yes' }), 'claude')).toBe(false);
	});
});

describe('PromptFiles', () => {
	const dirs: string[] = [];
	const tmp = (prefix: string) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	const filesOf = (repo: string, options: { trusted?: boolean; now?: () => number } = {}) => new PromptFiles({
		home: tmp('home-'),
		profilePromptsDir: tmp('profile-'),
		windowFolders: () => [repo],
		trusted: () => options.trusted ?? true,
		locations: () => undefined,
		now: options.now,
	});
	const names = (files: readonly CustomFile[]) => files.map(item => item.name);

	it('serves the same files within five seconds and rescans after', async () => {
		const repo = tmp('repo-');
		const folder = path.join(repo, '.github', 'instructions');
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, 'a.instructions.md'), 'Body');
		let clock = 1_000;
		const files = filesOf(repo, { now: () => clock });

		const first = await files.get(undefined);
		fs.writeFileSync(path.join(folder, 'b.instructions.md'), 'Body');
		clock += 4_999;
		const within = await files.get(undefined);
		clock += 1;
		const after = await files.get(undefined);

		expect(names(first)).toEqual(['a']);
		expect(within).toBe(first);
		expect(names(after)).toEqual(['a', 'b']);
	});

	it("uses the chat's own folders over the window's", async () => {
		const window = tmp('window-');
		const chat = tmp('chat-');
		fs.mkdirSync(path.join(chat, '.github', 'prompts'), { recursive: true });
		fs.writeFileSync(path.join(chat, '.github', 'prompts', 'ship.prompt.md'), 'Body');

		expect(names(await filesOf(window).get([chat]))).toEqual(['ship']);
		expect(names(await filesOf(chat).get([]))).toEqual(['ship']);
		expect(await filesOf(window).get(undefined)).toEqual([]);
	});

	it('reads no workspace folder when the workspace is not trusted', async () => {
		const repo = tmp('repo-');
		fs.mkdirSync(path.join(repo, '.github', 'instructions'), { recursive: true });
		fs.writeFileSync(path.join(repo, '.github', 'instructions', 'a.instructions.md'), 'Body');

		expect(names(await filesOf(repo, { trusted: true }).get(undefined))).toEqual(['a']);
		expect(await filesOf(repo, { trusted: false }).get(undefined)).toEqual([]);
		expect(await filesOf(repo, { trusted: false }).get([repo])).toEqual([]);
	});

	it('still reads the home and profile folders when the workspace is not trusted', async () => {
		const profile = tmp('profile-');
		fs.writeFileSync(path.join(profile, 'p.instructions.md'), 'Body');
		const files = new PromptFiles({ home: tmp('home-'), profilePromptsDir: profile, windowFolders: () => [], trusted: () => false, locations: () => undefined });

		expect(names(await files.get(undefined))).toEqual(['p']);
	});
});
