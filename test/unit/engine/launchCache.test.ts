/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, LaunchContext } from '../../../src/core/adapter';
import { AdapterNotInstalledError } from '../../../src/engine/acp/agentClient';
import { ChatService } from '../../../src/engine/chat/ChatService';
import type { AgentApi } from '../../../src/engine/chat/types';
import type { ToolResult } from '../../../src/engine/model/chat';
import type { HostPort } from '../../../src/engine/ports/host';

const adapter: AgentAdapter = {
	id: 'mock',
	displayName: 'Mock',
	vendor: 'acphub-mock',
	install: { kind: 'existing-cli', command: 'node' },
	launch: () => ({ command: 'node', args: [], env: {} }),
	auth: [],
	settings: [],
	modelPolicy: {} as AgentAdapter['modelPolicy'],
	systemPrompt: { toolAccess: '', listRequiredArguments: false },
};

const launch = (workspaceFolder: string): LaunchContext => ({ entryPath: 'fake', installDir: '', storageDir: '', settings: {}, workspaceFolder });

function memoryState() {
	const values = new Map<string, unknown>();
	return {
		get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
		update: (key: string, value: unknown): Promise<void> => { values.set(key, value); return Promise.resolve(); },
		keys: (): readonly string[] => [...values.keys()],
	};
}

function fakeHost(): HostPort {
	return {
		log: () => undefined,
		state: memoryState(),
		secrets: {
			get: () => Promise.resolve(undefined),
			set: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		},
		settings: { get: () => undefined },
		storageRoot: '',
		chatIdentity: request => ({ id: request.chatId, cwd: request.cwd, workspaceFolders: [] }),
		guidanceOf: () => undefined,
		stripHostSections: text => text,
		chatWideContextOf: () => undefined,
		executeTool: (): Promise<ToolResult> => Promise.resolve({ content: [] }),
		ui: {
			requestSignIn: () => undefined,
			notify: () => Promise.resolve(undefined),
			openExternal: () => Promise.resolve(),
		},
	};
}

/** A service whose launch probe is counted, over an agent that does nothing else. */
function service(resolve: () => LaunchContext | undefined) {
	const probes = { count: 0 };
	const agent = {
		updateContext: async (): Promise<void> => undefined,
		onDidChange: () => ({ dispose() { } }),
		dispose: (): void => undefined,
	};
	const chat = new ChatService({
		adapter,
		host: fakeHost(),
		bridge: {
			registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
			updateTools: () => undefined,
			unregisterSession: () => undefined,
		},
		resolveLaunch: () => {
			probes.count++;
			return Promise.resolve(resolve());
		},
		createClient: () => agent as unknown as AgentApi,
	});
	return { chat, probes };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the cached launch', () => {
	it('probes once for two calls, and again after a settings change', async () => {
		const { chat, probes } = service(() => launch('/work'));
		try {
			await chat.client();
			await chat.client();
			expect(probes.count).toBe(1);

			chat.invalidateLaunch();
			await chat.client();
			expect(probes.count).toBe(2);
		} finally {
			await chat.close();
		}
	});

	it('shares one probe among the calls of a burst', async () => {
		const { chat, probes } = service(() => launch('/work'));
		try {
			await Promise.all([chat.client(), chat.client(), chat.client()]);
			expect(probes.count).toBe(1);
		} finally {
			await chat.close();
		}
	});

	it('remembers a missing agent only for the short wait', async () => {
		const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
		const { chat, probes } = service(() => undefined);
		try {
			await expect(chat.client()).rejects.toThrow(AdapterNotInstalledError);
			await expect(chat.client()).rejects.toThrow(AdapterNotInstalledError);
			expect(probes.count).toBe(1);

			now.mockReturnValue(1_000 + 5_001);
			await expect(chat.client()).rejects.toThrow(AdapterNotInstalledError);
			expect(probes.count).toBe(2);
		} finally {
			await chat.close();
		}
	});
});
