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
import type { ControlState } from '../../../src/ui/messages';
import { ControlPage } from '../../../src/ui/controlPage';

const MOCK_AGENT = path.resolve(__dirname, '..', '..', 'fixtures', 'mock-acp-agent.cjs');

/** The mock ACP agent, which streams "hello" and ends its turn with the token counts of a model call. */
function mockAdapter(mode = 'normal', usage?: AgentAdapter['usage']): AgentAdapter {
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
		usage,
	};
}

const cleanups: Array<() => Promise<void>> = [];

/** The gateway as the server builds it, over the mock agent and a store of its own. */
function gateway(mode = 'normal', usage?: AgentAdapter['usage']): HeadlessGateways {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-wiring-'));
	const composition = createHeadlessComposition({
		root,
		log: () => undefined,
		adapters: [mockAdapter(mode, usage)],
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

	it('records the tokens of a finished turn in the usage history', async () => {
		const composition = gateway();

		await composition.serviceOf('mock')!.respond(request('chat-ledger'), () => undefined, new AbortController().signal);

		const view = await composition.usageHistory.view();
		expect(view.empty).toBe(false);
		expect(view.days).toHaveLength(1);
		expect(view.days[0]?.v.some(tokens => tokens > 0)).toBe(true);
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

	it('redraws the page as signed out when an agent with a usage source refuses for lack of credentials', async () => {
		let reads = 0;
		const composition = gateway('auth-required', {
			read: async () => {
				reads++;
				return { windows: [{ label: '5h', usedPercent: 10 }] };
			},
		});
		// A fresh reading proves the account, so nothing about the usage would tell the page the sign-in expired.
		await composition.usage.refresh(composition.adapters[0], { launch: {} as never, askAgent: async () => undefined }, true);
		expect(composition.control.usage('mock').signedIn).toBe(true);

		const states: ControlState[] = [];
		const page = new ControlPage(composition.control, { openExternal: async () => { }, copyToClipboard: async () => { } });
		page.onState(state => { states.push(state); });
		await page.handle({ type: 'ready' });
		expect(states.at(-1)?.agents[0].signedIn).toBe('yes');

		await composition.serviceOf('mock')!.respond(request('chat-expired'), () => undefined, new AbortController().signal).catch(() => undefined);

		await vi.waitFor(() => expect(states.at(-1)?.agents[0].signedIn).toBe('no'), { timeout: 10_000 });
		expect(composition.host.state.get('signedIn.mock')).toBe(false);
		expect(reads).toBe(1);
	});
});
