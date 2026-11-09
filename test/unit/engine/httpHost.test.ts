/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessComposition } from '../../../src/composition/headless';
import type { AgentAdapter } from '../../../src/core/adapter';
import { readAgentSettings } from '../../../src/core/settings';
import type { ToolBridge } from '../../../src/engine/chat/types';
import type { ChatRequest } from '../../../src/engine/model/chat';
import { DEFAULT_CHAT_OWNER } from '../../../src/engine/ports/host';
import { configFileOf } from '../../../src/hosts/http/config';
import { createHeadlessHost, ownerOfToken, rememberHeaders } from '../../../src/hosts/http/host';

const NO_LOG = (): void => undefined;

const roots: string[] = [];

/** A store root of its own for one test, removed afterwards. */
function storeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-http-'));
	roots.push(root);
	return root;
}

function hostAt(root: string) {
	return createHeadlessHost({ root, log: NO_LOG });
}

/** A request as the HTTP server hands it to the engine before it is named. */
function chat(text = 'hello', cwd = '/work'): ChatRequest {
	return { chatId: '', cwd, messages: [{ role: 'user', parts: [{ type: 'text', text }] }], tools: [] };
}

/** An adapter with one declared setting, to prove the configuration key scheme. */
function fakeAdapter(): AgentAdapter {
	return {
		id: 'mock',
		displayName: 'Mock',
		vendor: 'acphub-mock',
		install: { kind: 'existing-cli', command: 'node' },
		launch: () => ({ command: 'node', args: [], env: {} }),
		auth: [],
		settings: [{ key: 'model', type: 'string', label: 'Model', description: '', default: 'default-model' }],
		modelPolicy: {} as AgentAdapter['modelPolicy'],
		systemPrompt: { toolAccess: '', listRequiredArguments: false },
	};
}

/** A bridge that hands out an endpoint and runs nothing; the HTTP client runs the tools. */
const noTools: ToolBridge = {
	registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
	updateTools: () => undefined,
	unregisterSession: () => undefined,
};

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('the headless host', () => {
	it('keeps its store in the root it was given', () => {
		const root = storeRoot();
		const host = hostAt(root);

		expect(host.storageRoot).toBe(path.resolve(root));
		expect(fs.existsSync(root)).toBe(true);
	});

	it('writes state to one file and reads it back from another host', async () => {
		const root = storeRoot();
		const host = hostAt(root);

		await host.state.update('acpHub.savedSessions.mock', { sessionId: 'session-1' });
		await host.state.update('signedIn.mock', true);

		const reopened = hostAt(root);
		expect(reopened.state.get('acpHub.savedSessions.mock')).toEqual({ sessionId: 'session-1' });
		expect(reopened.state.get('signedIn.mock')).toBe(true);
		expect([...reopened.state.keys()].sort()).toEqual(['acpHub.savedSessions.mock', 'signedIn.mock']);
	});

	it('replaces state atomically and leaves no temp file behind', async () => {
		const root = storeRoot();
		const host = hostAt(root);

		await host.state.update('acpHub.probe', { again: 1 });
		await host.state.update('acpHub.probe', { again: 2 });

		expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
		expect(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))).toEqual({
			revision: 2,
			values: { 'acpHub.probe': { again: 2 } },
		});
	});

	it('keeps the agents keys in a file of their own', async () => {
		const root = storeRoot();
		const host = hostAt(root);

		await host.secrets.set('mock', 'sk-test');
		expect(await hostAt(root).secrets.get('mock')).toBe('sk-test');
		expect(fs.readdirSync(root)).toContain('secrets.json');

		await host.secrets.delete('mock');
		expect(await host.secrets.get('mock')).toBeUndefined();
	});

	it('reads agent settings from config.json below acpHub, as VS Code reads them', () => {
		const root = storeRoot();
		const host = hostAt(root);

		fs.writeFileSync(configFileOf(root), JSON.stringify({ acpHub: { agents: { mock: { model: 'configured' } } } }));

		expect(host.settings.get<string>('agents.mock.model')).toBe('configured');
		const { values, warnings } = readAgentSettings(fakeAdapter(), host.settings);
		expect(values.model).toBe('configured');
		expect(warnings).toEqual([]);
	});

	it('runs without settings when config.json is not readable', () => {
		const root = storeRoot();
		fs.writeFileSync(configFileOf(root), '{ not json');

		expect(hostAt(root).settings.get('agents.mock.model')).toBeUndefined();
	});

	it('names a chat by its folder and opening, so a re-post finds the same one', () => {
		const host = hostAt(storeRoot());

		expect(host.chatIdentity(chat('hello')).id).toBe(host.chatIdentity(chat('hello')).id);
		expect(host.chatIdentity(chat('hello')).id).not.toBe(host.chatIdentity(chat('other')).id);
		expect(host.chatIdentity(chat('hello')).id).not.toBe(host.chatIdentity(chat('hello', '/elsewhere')).id);
	});

	it('keeps the name a client gives its chat', () => {
		const host = hostAt(storeRoot());
		const first = chat('hello');
		const second = chat('hello');
		rememberHeaders(first, { chatId: 'client-one' });
		rememberHeaders(second, { chatId: 'client-two' });

		expect(host.chatIdentity(first).id).toBe('client-one');
		expect(host.chatIdentity(second).id).toBe('client-two');
	});

	it('works in the folder the client names, then the request folder, then the configured one', () => {
		const root = storeRoot();
		const host = hostAt(root);
		fs.writeFileSync(configFileOf(root), JSON.stringify({ acpHub: { defaultWorkspace: '/configured' } }));

		const named = chat('hello', '/request');
		rememberHeaders(named, { cwd: '/from-header' });
		expect(host.chatIdentity(named).cwd).toBe('/from-header');
		expect(host.chatIdentity(chat('hello', '/request')).cwd).toBe('/request');
		expect(host.chatIdentity(chat('hello', '')).cwd).toBe('/configured');
	});

	it('names the owner of its chats, so each principal has its own quota', () => {
		const host = hostAt(storeRoot());
		expect(host.chatIdentity(chat('hello')).owner).toBe(DEFAULT_CHAT_OWNER);

		const tokened = createHeadlessHost({ root: storeRoot(), log: NO_LOG, owner: ownerOfToken('one-token') });
		expect(tokened.chatIdentity(chat('hello')).owner).toMatch(/^bearer:[0-9a-f]{8}$/);
		expect(ownerOfToken('one-token')).toBe(ownerOfToken('one-token'));
		expect(ownerOfToken('one-token')).not.toBe(ownerOfToken('another-token'));
	});

	it('hands the request its own guidance and leaves forwarded text alone', () => {
		const host = hostAt(storeRoot());

		expect(host.guidanceOf({ ...chat(), systemGuidance: 'be brief' })).toBe('be brief');
		expect(host.guidanceOf(chat())).toBeUndefined();
		expect(host.stripHostSections('<kept>text</kept>')).toBe('<kept>text</kept>');
		expect(host.chatWideContextOf([])).toBeUndefined();
	});

	it('refuses to run a tool itself', () => {
		const host = hostAt(storeRoot());

		expect(() => host.executeTool({ type: 'tool-call', callId: 'call-1', name: 'read', input: {} }, new AbortController().signal))
			.toThrow(/not used by this host/);
	});
});

describe('the headless composition', () => {
	it('drives every registered adapter from one store root', async () => {
		const root = storeRoot();
		const composition = createHeadlessComposition({ root, log: NO_LOG, bridge: noTools });

		expect(composition.host.storageRoot).toBe(path.resolve(root));
		for (const adapter of composition.adapters) {
			expect(composition.serviceOf(adapter.id), adapter.id).toBeDefined();
		}
		expect(composition.serviceOf('no-such-agent')).toBeUndefined();

		await composition.close();
	});
});
