/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessComposition, type HeadlessGateways } from '../../../src/composition/headless';
import type { AgentAdapter } from '../../../src/core/adapter';
import type { ChatRequest } from '../../../src/engine/model/chat';

const MOCK_AGENT = path.resolve(__dirname, '..', '..', 'fixtures', 'mock-acp-agent.cjs');

/** The mock ACP agent, which streams "hello" and ends its turn with the token counts of a model call. */
function mockAdapter(mode = 'normal'): AgentAdapter {
	return {
		id: 'mock',
		displayName: 'Mock',
		vendor: 'acphub-mock',
		install: { kind: 'existing-cli', command: 'node' },
		findCommandOverride: () => MOCK_AGENT,
		launch: () => ({ command: process.execPath, args: [MOCK_AGENT], env: { MOCK_ACP_MODE: mode } }),
		auth: [],
		settings: [],
		modelPolicy: {} as AgentAdapter['modelPolicy'],
		systemPrompt: { toolAccess: '', listRequiredArguments: false },
	};
}

const cleanups: Array<() => Promise<void>> = [];

/** The gateway as the server builds it, over the mock agent and a store of its own. */
function gateway(mode = 'normal'): HeadlessGateways {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-wiring-'));
	const composition = createHeadlessComposition({
		root,
		log: () => undefined,
		adapters: [mockAdapter(mode)],
		bridge: {
			registerSession: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: 'token' }),
			updateTools: () => undefined,
			unregisterSession: () => undefined,
		},
	});
	cleanups.push(async () => {
		await composition.close();
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	return composition;
}

function request(chatId: string, text = 'hi'): ChatRequest {
	return { chatId, cwd: process.cwd(), messages: [{ role: 'user', parts: [{ type: 'text', text }] }], tools: [], model: 'mock-model' };
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
	vi.restoreAllMocks();
});

describe('headless composition wiring', () => {
	it('records a finished turn in the usage the page shows', async () => {
		const composition = gateway();

		await composition.serviceOf('mock')!.respond(request('chat-usage'), () => undefined, new AbortController().signal);

		const windows = composition.control.usage('mock').extraWindows.map(window => window.label);
		expect(windows).toContain('Cumulative cache hit rate');
		expect(composition.usage.get('mock').extraWindows).toEqual(composition.control.usage('mock').extraWindows);
	});

	it('reads the transcript detail from config.json', async () => {
		const composition = gateway();
		expect(composition.transcriptOptions().detail).toBe('compact');

		await composition.host.writeSetting('resume.transcriptDetail', 'full');

		expect(composition.transcriptOptions().detail).toBe('full');
	});

	it('marks the agent signed out when it refuses a request for lack of credentials', async () => {
		const composition = gateway('auth-required');

		await composition.serviceOf('mock')!.respond(request('chat-auth'), () => undefined, new AbortController().signal).catch(() => undefined);

		await vi.waitFor(() => expect(composition.host.state.get('signedIn.mock')).toBe(false), { timeout: 10_000 });
	});
});
