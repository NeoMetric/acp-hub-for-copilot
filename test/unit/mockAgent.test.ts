/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const MOCK_AGENT = path.resolve(__dirname, '..', 'fixtures', 'mock-acp-agent.cjs');

type Message = Record<string, any>;

/** Starts the mock agent and lets a test send requests and wait for what comes back. */
class MockProcess {
	readonly child: cp.ChildProcessWithoutNullStreams;
	readonly received: Message[] = [];
	readonly garbage: string[] = [];
	private buffer = '';
	private nextId = 1;
	exitCode: number | null | undefined;

	constructor(mode: string) {
		this.child = cp.spawn(process.execPath, [MOCK_AGENT], { env: { ...process.env, MOCK_ACP_MODE: mode } });
		this.child.stdout.on('data', chunk => this.onData(String(chunk)));
		this.child.on('exit', code => { this.exitCode = code; });
	}

	private onData(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() ?? '';
		for (const line of lines) {
			try {
				this.received.push(JSON.parse(line));
			} catch {
				this.garbage.push(line);
			}
		}
	}

	send(method: string, params: unknown): number {
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		return id;
	}

	notify(method: string, params: unknown): void {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
	}

	async until(done: () => boolean): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (!done()) {
			if (Date.now() > deadline) {
				throw new Error(`Timed out. Received: ${JSON.stringify(this.received)}`);
			}
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	}

	async response(id: number): Promise<Message> {
		await this.until(() => this.received.some(message => message.id === id && message.method === undefined));
		return this.received.find(message => message.id === id && message.method === undefined) as Message;
	}

	updates(): string[] {
		return this.received
			.filter(message => message.method === 'session/update')
			.map(message => message.params.update.content.text);
	}
}

let agent: MockProcess | undefined;

function start(mode: string): MockProcess {
	agent = new MockProcess(mode);
	return agent;
}

async function openSession(mock: MockProcess): Promise<string> {
	await mock.response(mock.send('initialize', { protocolVersion: 1 }));
	const created = await mock.response(mock.send('session/new', { cwd: '.', mcpServers: [] }));
	return created.result.sessionId;
}

afterEach(() => {
	agent?.child.kill();
	agent = undefined;
});

describe('mock ACP agent', () => {
	it('normal: initializes, reports models and effort, and streams hello', async () => {
		const mock = start('normal');
		const initialized = await mock.response(mock.send('initialize', { protocolVersion: 1 }));
		expect(initialized.result.protocolVersion).toBe(1);

		const created = await mock.response(mock.send('session/new', { cwd: '.', mcpServers: [] }));
		const sessionId = created.result.sessionId;
		expect(created.result.configOptions.map((option: Message) => option.id)).toEqual(['model', 'effort']);

		const turn = await mock.response(mock.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }));
		expect(turn.result.stopReason).toBe('end_turn');
		expect(mock.updates()).toEqual(['hello']);
	});

	it('auth-required: session/new fails with -32000', async () => {
		const mock = start('auth-required');
		await mock.response(mock.send('initialize', { protocolVersion: 1 }));
		const created = await mock.response(mock.send('session/new', { cwd: '.', mcpServers: [] }));
		expect(created.error.code).toBe(-32000);
	});

	it('crash-mid-request: exits while a prompt runs', async () => {
		const mock = start('crash-mid-request');
		const sessionId = await openSession(mock);
		mock.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
		await mock.until(() => mock.exitCode !== undefined);
		expect(mock.exitCode).toBe(2);
	});

	it('garbage: writes lines that are not JSON next to valid replies', async () => {
		const mock = start('garbage');
		const initialized = await mock.response(mock.send('initialize', { protocolVersion: 1 }));
		expect(initialized.result.protocolVersion).toBe(1);
		expect(mock.garbage.length).toBeGreaterThan(0);
	});

	it('slow: a prompt only ends after session/cancel', async () => {
		const mock = start('slow');
		const sessionId = await openSession(mock);
		const promptId = mock.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
		await mock.until(() => mock.updates().length > 0);
		expect(mock.received.some(message => message.id === promptId)).toBe(false);

		mock.notify('session/cancel', { sessionId });
		const turn = await mock.response(promptId);
		expect(turn.result.stopReason).toBe('cancelled');
	});

	it('usage: answers account/rateLimits/read with fixed numbers', async () => {
		const mock = start('usage');
		const limits = await mock.response(mock.send('account/rateLimits/read', {}));
		expect(limits.result.primary.usedPercent).toBe(42);
		expect(limits.result.secondary.usedPercent).toBe(7);
	});
});
