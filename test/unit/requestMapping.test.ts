/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { stripIdentity } from '../../src/core/identityPatterns';
import { chatIdOf, chatLabelOf, resolveCwd, sessionKey, systemGuidanceOf, workspaceFoldersOf } from '../../src/hosts/vscode/identity';
import { bodyOf } from '../../src/hosts/vscode/requestMapping';
import { assistant, image, system, toolCall, user } from './messages';
import { LanguageModelTextPart, LanguageModelToolResultPart } from './vscode-mock';

/** The body the module hands back opaque, narrowed to what a test reads. */
interface Body {
	model: string;
	stream: boolean;
	messages: Array<{ role: string; content?: string | unknown[]; tool_calls?: unknown[]; tool_call_id?: string }>;
	tools?: unknown[];
	reasoning_effort?: string;
	acp: { chatId?: string; sessionKey?: string; label?: string; cwd?: string; workspaceFolders?: string[]; systemGuidance?: string; chatContext?: string };
}

const MODEL = { id: 'claude-sonnet-4' } as unknown as vscode.LanguageModelChatInformation;

function optionsOf(overrides: Record<string, unknown> = {}, tools: readonly unknown[] = []): vscode.ProvideLanguageModelChatResponseOptions {
	return { modelOptions: {}, tools, toolMode: 1, ...overrides } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
}

function bodyFor(messages: readonly vscode.LanguageModelChatRequestMessage[], overrides: Record<string, unknown> = {}, modelId = MODEL.id, windowFolder = 'c:\\window'): Body {
	return bodyOf({ id: modelId } as vscode.LanguageModelChatInformation, 'claude', messages, optionsOf(overrides), windowFolder) as Body;
}

/** The system prompt the Copilot SDK host sends, which names the chat's own directory. */
const hostSystem = (cwd: string) => system(
	`You are an AI assistant using Copilot SDK in VS Code.\n<environment_context>\n* Current working directory: ${cwd}\n* Operating System: windows\n</environment_context>\nMore guidance.`,
);

/** The first user message Copilot sends: environment and workspace, with no request. */
const globalContext = () => user(
	"<environment_info>\nThe user's current OS is: Windows\n</environment_info>\n<workspace_info>\nI am working in a workspace with the following folders:\n- c:\\work\\app \n</workspace_info>",
);

const request = () => user('<userRequest>\nfix the bug\n</userRequest>');

describe('bodyOf', () => {
	it('names the model with its agent and drops the ::agent suffix', () => {
		expect(bodyFor([user('hi')], {}, 'claude-sonnet-4::agent').model).toBe('claude/claude-sonnet-4');
		expect(bodyFor([user('hi')]).model).toBe('claude/claude-sonnet-4');
	});

	it('asks the server to stream the turn', () => {
		expect(bodyFor([user('hi')]).stream).toBe(true);
	});

	it('sends the chat id, label, folders, cwd and guidance the host computed before', () => {
		const messages = [hostSystem('c:\\work\\app'), globalContext(), request()];
		const options = optionsOf();
		const body = bodyOf(MODEL, 'claude', messages, options, 'c:\\window') as Body;

		expect(body.acp.chatId).toBe(chatIdOf(messages, options));
		expect(body.acp.label).toBe(chatLabelOf(messages));
		expect(body.acp.workspaceFolders).toEqual(workspaceFoldersOf(messages));
		expect(body.acp.cwd).toBe(resolveCwd(workspaceFoldersOf(messages), 'c:\\window'));
		expect(body.acp.systemGuidance).toBe(stripIdentity(systemGuidanceOf(messages) ?? ''));
	});

	it('keys the agent session on the chat session key, apart from the id its figures use', () => {
		const options = optionsOf({ modelOptions: { _conversationId: 'conversation-1' } });
		const opening = [hostSystem('c:\\work\\app'), globalContext(), request()];
		const other = [hostSystem('c:\\work\\app'), globalContext(), user('<userRequest>\nnow research it\n</userRequest>')];
		const one = bodyOf(MODEL, 'claude', opening, options, 'c:\\window') as Body;
		const two = bodyOf(MODEL, 'claude', other, options, 'c:\\window') as Body;

		// The session key hashes the whole opening, not just the first message, so a
		// sub-agent of one chat — same conversation, different opening — gets a session of its own.
		expect(one.acp.sessionKey).toBe(sessionKey(opening, options));
		expect(two.acp.sessionKey).toBe(sessionKey(other, options));
		expect(one.acp.sessionKey).not.toBe(two.acp.sessionKey);
		// The id the figures of the chat use is the same for both, as it was before.
		expect(one.acp.chatId).toBe(chatIdOf(opening, options));
		expect(two.acp.chatId).toBe(one.acp.chatId);
		expect(one.acp.sessionKey).not.toBe(one.acp.chatId);
	});

	it('leaves out the guidance when the request carries no system message', () => {
		expect(bodyFor([user('hi')]).acp.systemGuidance).toBeUndefined();
	});

	it('carries the context of the chat as the messages wrote it, before the host sections are taken out', () => {
		const messages = [
			user("<environment_info>\nThe user's current OS is: Windows\n</environment_info>\n<workspace_info>\nOne folder\n</workspace_info>"),
			request(),
		];

		expect(bodyFor(messages).acp.chatContext)
			.toBe("<environment_info>\nThe user's current OS is: Windows\n</environment_info>\n\n<workspace_info>\nOne folder\n</workspace_info>");
	});

	it('takes the host sections out of the text it sends, so a context-only message carries none', () => {
		const messages = [
			user('<environment_info>Windows</environment_info><workspace_info>One folder</workspace_info>'),
			request(),
		];

		expect(bodyFor(messages).messages).toEqual([{ role: 'user', content: '<userRequest>\nfix the bug\n</userRequest>' }]);
	});

	it('sends a system message as one, without its host sections', () => {
		const body = bodyFor([system('You are an assistant.<environment_info>Windows</environment_info>'), request()]);

		expect(body.messages[0]).toEqual({ role: 'system', content: 'You are an assistant.' });
	});

	it('sends an image part as an image_url data URL', () => {
		const body = bodyFor([user('what is this?', image([1, 2, 3]))]);

		expect(body.messages).toEqual([{
			role: 'user',
			content: [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` } },
			],
		}]);
	});

	it('sends the tool calls of an assistant message as function calls', () => {
		const body = bodyFor([user('read it'), assistant(toolCall('call_1', 'read_file'))]);

		expect(body.messages[1]).toEqual({
			role: 'assistant',
			tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
		});
	});

	it('sends a tool result as the tool message that answers its call', () => {
		const messages = [
			user('read it'),
			assistant(toolCall('call_1', 'read_file')),
			user(new LanguageModelToolResultPart('call_1', [new LanguageModelTextPart('the file')])),
		];

		expect(bodyFor(messages).messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'the file' });
	});

	it('marks a failed tool result the way the server reads a failure: text starting with "error:"', () => {
		const failed = new LanguageModelToolResultPart('call_1', [new LanguageModelTextPart('the file is missing')], true);
		const body = bodyFor([user('read it'), assistant(toolCall('call_1', 'read_file')), user(failed)]);
		const result = body.messages[2];

		expect(result).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'error: the file is missing' });
		expect(String(result.content)).toMatch(/^\s*error\s*:/i);
	});

	it('offers the tools of the request as function tools', () => {
		const parameters = { type: 'object', properties: { path: { type: 'string' } } };
		const body = bodyOf(MODEL, 'claude', [user('hi')], optionsOf({}, [{ name: 'read_file', description: 'Reads a file.', inputSchema: parameters }]), 'c:\\window') as Body;

		expect(body.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: 'Reads a file.', parameters } }]);
	});

	it('sends no tools when the request offers none', () => {
		expect(bodyFor([user('hi')]).tools).toBeUndefined();
	});

	it('forwards the effort the picker chose, and none when it chose none', () => {
		expect(bodyFor([user('hi')], { modelConfiguration: { reasoningEffort: 'high' } }).reasoning_effort).toBe('high');
		expect(bodyFor([user('hi')], { modelOptions: { reasoningEffort: 'low' } }).reasoning_effort).toBe('low');
		expect(bodyFor([user('hi')]).reasoning_effort).toBeUndefined();
	});
});
