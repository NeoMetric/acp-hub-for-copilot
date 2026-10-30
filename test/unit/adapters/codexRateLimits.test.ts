/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogLevel } from '../../../src/core/logging';
const ADAPTER_VERSION = '2.3.0';
import { readRateLimits, type RateWindows } from '../../../src/adapters/codexRateLimits';

const fakeServer = path.join(__dirname, '..', '..', 'fixtures', 'fake-app-server.cjs');
const TOUCHED_ENV = ['CODEX_HOME', 'FAKE_APP_SERVER_MODE', 'FAKE_RATE_LIMITS', 'FAKE_APP_SERVER_PID_FILE', 'FAKE_APP_SERVER_LOG'];
const savedEnv = new Map(TOUCHED_ENV.map(name => [name, process.env[name]]));

let root: string;
let pidFile: string;
let logFile: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-rate-limits-'));
	pidFile = path.join(root, 'app-server.pid');
	logFile = path.join(root, 'app-server.log');
	process.env.FAKE_APP_SERVER_PID_FILE = pidFile;
	process.env.FAKE_APP_SERVER_LOG = logFile;
	delete process.env.CODEX_HOME;
});

afterEach(() => {
	for (const name of TOUCHED_ENV) {
		const value = savedEnv.get(name);
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	fs.rmSync(root, { recursive: true, force: true });
});

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Waits for the killed app server to be gone, which the kill does asynchronously. */
async function expectChildKilled(): Promise<void> {
	const pid = Number(fs.readFileSync(pidFile, 'utf8'));
	expect(pid).toBeGreaterThan(0);
	await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 15_000, interval: 25 });
}

/** Lays out an installed adapter with the pinned Codex package beside it, as npm does. */
function installAdapter(script: string): string {
	const adapter = path.join(root, 'adapter');
	const codex = path.join(adapter, 'node_modules', '@openai', 'codex');
	fs.mkdirSync(path.join(codex, 'bin'), { recursive: true });
	fs.writeFileSync(path.join(codex, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.0.0-test', bin: { codex: 'bin/codex.js' } }));
	fs.writeFileSync(path.join(codex, 'bin', 'codex.js'), `require(${JSON.stringify(fakeServer)});\n`);
	fs.writeFileSync(path.join(adapter, 'index.js'), 'module.exports = {};\n');
	process.env.FAKE_APP_SERVER_MODE = script;
	delete process.env.FAKE_RATE_LIMITS;
	return path.join(adapter, 'index.js');
}

/** An adapter whose Codex package answers `account/rateLimits/read` with `payload`. */
function answering(payload: unknown): string {
	const entry = installAdapter('ok');
	process.env.FAKE_RATE_LIMITS = JSON.stringify(payload);
	return entry;
}

const window = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null = 1_760_000_000) => ({ usedPercent, windowDurationMins, resetsAt });
/** What one `rateLimits`/`rateLimitsByLimitId` entry looks like, from the probe note's source-derived shape. */
const snapshot = (primary: unknown, secondary?: unknown) => ({
	limitId: 'codex', limitName: 'Codex', primary, secondary, credits: null, spendControlReached: false, planType: 'plus',
});

const read = (entry: string, timeoutMs = 20_000) => readRateLimits(entry, { timeoutMs, adapterVersion: ADAPTER_VERSION });

/** The windows of a read that must have found plan limits, so the other outcomes cannot slip through. */
async function readWindows(entry: string, timeoutMs = 20_000): Promise<RateWindows> {
	const result = await read(entry, timeoutMs);
	expect(result.kind).toBe('limits');
	return result.kind === 'limits' ? result.windows : {};
}

/** Drives the fake app server directly, to check what it refuses. */
function fakeServerChild(mode: string): cp.ChildProcess {
	return cp.spawn(process.execPath, [fakeServer], {
		env: { ...process.env, FAKE_APP_SERVER_MODE: mode },
		stdio: ['pipe', 'pipe', 'ignore'],
		windowsHide: true,
	});
}

/** The first JSON line the child writes. */
function firstLine(child: cp.ChildProcess): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let buffer = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf('\n');
			if (index < 0) {
				return;
			}
			resolve(JSON.parse(buffer.slice(0, index)));
		});
		child.on('error', reject);
		child.on('exit', code => reject(new Error(`the fake app server exited with ${String(code)}`)));
	});
}

describe('readRateLimits', () => {
	it('reads the limits of the account signed in to the extension CODEX_HOME', async () => {
		const entry = answering({ rateLimits: snapshot(window(12, 300)) });
		const codexHome = path.join(root, 'codex-home');

		await readRateLimits(entry, { timeoutMs: 20_000, codexHome, adapterVersion: ADAPTER_VERSION });

		expect(fs.readFileSync(logFile, 'utf8')).toContain(`codex-home ${codexHome}`);
	});

	it('reads the primary and secondary windows into the five-hour and weekly buckets', async () => {
		const entry = answering({ rateLimits: snapshot(window(12, 300, 1_760_000_000), window(40, 10080, 1_760_600_000)) });

		const windows = await readWindows(entry);

		expect(windows.fiveHour).toEqual({ usedPercent: 12, windowDurationMins: 300, resetsAt: 1_760_000_000 });
		expect(windows.weekly).toEqual({ usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_760_600_000 });
		await expectChildKilled();
	});

	it('sorts the windows by their duration rather than by their position', async () => {
		const entry = answering({ rateLimits: snapshot(window(70, 10080), window(5, 300)) });

		const windows = await readWindows(entry);

		expect(windows.fiveHour?.usedPercent).toBe(5);
		expect(windows.weekly?.usedPercent).toBe(70);
	});

	it('reads a window without a duration by its name: primary is the short one', async () => {
		const entry = answering({ rateLimits: snapshot(window(8, null, null)) });

		expect(await readWindows(entry)).toEqual({ fiveHour: { usedPercent: 8, windowDurationMins: null, resetsAt: null } });
	});

	it('reads a secondary window without a duration as the long one', async () => {
		const entry = answering({ rateLimits: snapshot(window(8, null, null), window(30, null, null)) });

		const windows = await readWindows(entry);

		expect(windows.fiveHour).toEqual({ usedPercent: 8, windowDurationMins: null, resetsAt: null });
		expect(windows.weekly).toEqual({ usedPercent: 30, windowDurationMins: null, resetsAt: null });
	});

	it('invents no window the response does not carry', async () => {
		const entry = answering({ rateLimits: snapshot(window(12, 300)) });

		expect(await readWindows(entry)).toEqual({ fiveHour: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_760_000_000 } });
	});

	it('prefers rateLimitsByLimitId, and the codex entry in it', async () => {
		const entry = answering({
			rateLimits: snapshot(window(1, 300), window(2, 10080)),
			rateLimitsByLimitId: {
				other: snapshot(window(3, 300), window(4, 10080)),
				codex: snapshot(window(12, 300), window(40, 10080)),
			},
		});

		const windows = await readWindows(entry);

		expect(windows.fiveHour?.usedPercent).toBe(12);
		expect(windows.weekly?.usedPercent).toBe(40);
	});

	it('takes the first entry of rateLimitsByLimitId when there is no codex one', async () => {
		const entry = answering({
			rateLimits: snapshot(window(1, 300)),
			rateLimitsByLimitId: { other: snapshot(window(3, 300), window(4, 10080)) },
		});

		expect((await readWindows(entry)).fiveHour?.usedPercent).toBe(3);
	});

	it('falls back to rateLimits when the map is empty', async () => {
		const entry = answering({ rateLimits: snapshot(window(1, 300), window(2, 10080)), rateLimitsByLimitId: {} });

		const windows = await readWindows(entry);

		expect(windows.fiveHour?.usedPercent).toBe(1);
		expect(windows.weekly?.usedPercent).toBe(2);
	});

	it('reports a failure, not a missing plan, for an adapter that is not installed', async () => {
		expect(await read(path.join(root, 'not-installed', 'index.js'), 500)).toEqual({
			kind: 'failed',
			reason: expect.stringContaining('@openai/codex'),
		});
	});

	it.each([
		['an answer without a rate-limit snapshot', {}],
		['an answer with something else in it', { somethingElse: true }],
	])('reports %s as a failure, not as an account without a plan', async (_name, payload) => {
		const entry = answering(payload);

		expect(await read(entry)).toEqual({ kind: 'failed', reason: expect.stringContaining('without a rate-limit snapshot') });
		await expectChildKilled();
	});

	it('reports a snapshot without a usable window as a failure', async () => {
		const entry = answering({ rateLimits: { limitId: 'codex', primary: { usedPercent: 'twelve' }, secondary: null } });

		expect(await read(entry)).toEqual({ kind: 'failed', reason: expect.stringContaining('carried no usable window') });
		await expectChildKilled();
	});

	it('reports the -32600 answer as an account without a ChatGPT plan', async () => {
		const entry = installAdapter('auth-error');

		expect(await read(entry)).toEqual({ kind: 'no-plan' });
		await expectChildKilled();
	});

	it('reports a timeout as a failure, and kills the app server', async () => {
		const entry = installAdapter('quiet');
		const started = Date.now();

		expect(await read(entry, 1_500)).toEqual({ kind: 'failed', reason: expect.stringContaining('did not answer within 1500 ms') });

		expect(Date.now() - started).toBeLessThan(15_000);
		await expectChildKilled();
	});

	it('reports a stream it cannot read as a failure, and kills the process', async () => {
		const entry = installAdapter('garbage');

		expect(await read(entry, 1_500)).toEqual({ kind: 'failed', reason: expect.stringContaining('did not answer within 1500 ms') });

		await expectChildKilled();
	});

	it('reports an app server that exits at once as a failure', async () => {
		const entry = installAdapter('exit');

		expect(await read(entry)).toEqual({ kind: 'failed', reason: expect.stringContaining('exit code 3') });

		await expectChildKilled();
	});

	it('starts the app server as node, with the handshake the pinned adapter sends, then the read without parameters', async () => {
		const entry = answering({ rateLimits: snapshot(window(12, 300)) });

		await read(entry);

		const seen = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
		expect(seen.slice(0, 3)).toEqual(['argv app-server', 'electron-run-as-node 1', 'request initialize']);
		expect(seen[3].startsWith('initialize-params ')).toBe(true);
		expect(JSON.parse(seen[3].slice('initialize-params '.length))).toEqual({
			capabilities: { experimentalApi: true, requestAttestation: false },
			clientInfo: { name: '@agentclientprotocol/codex-acp', version: ADAPTER_VERSION, title: 'Codex ACP' },
		});
		expect(seen.slice(4)).toEqual(['request account/rateLimits/read', 'params omitted']);
	});

	it('refuses a read that arrives before the handshake, like the real app server', async () => {
		const child = fakeServerChild('ok');
		const answered = firstLine(child);
		child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' })}\n`);

		expect(await answered).toEqual({ id: 2, error: { code: -32600, message: 'initialize required before any other request' } });
		expect(fs.readFileSync(logFile, 'utf8')).toContain('refused-before-handshake');
		child.kill();
	});

	it('keeps the payload out of the log', async () => {
		const entry = answering({
			rateLimits: { ...snapshot(window(12, 300)), planType: 'plus-secret-plan', credits: { balance: 'top-secret-credit' } },
		});
		const messages: string[] = [];
		const levels: Array<LogLevel | undefined> = [];

		await readRateLimits(entry, { timeoutMs: 20_000, adapterVersion: ADAPTER_VERSION, log: (message, level) => { messages.push(message); levels.push(level); } });

		expect(messages.length).toBeGreaterThan(0);
		for (const message of messages) {
			expect(message).not.toContain('plus-secret-plan');
			expect(message).not.toContain('top-secret-credit');
			expect(message).not.toContain('planType');
		}
		expect(levels.every(level => level === 'debug')).toBe(true);
	});
});
