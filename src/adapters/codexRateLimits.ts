/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Log } from '../core/logging';
import { killTree, trackChild } from '../core/processes';

/** One plan limit window, as the Codex app server reports it. */
export interface RateWindow {
	readonly usedPercent: number;
	readonly windowDurationMins: number | null;
	/** Epoch seconds; the app server counts seconds, which is why the adapter renders `resetsAt * 1e3`. */
	readonly resetsAt: number | null;
}

/** What one read can find. A window is absent when the account has no such limit. */
export interface RateWindows {
	readonly fiveHour?: RateWindow;
	readonly weekly?: RateWindow;
}

/**
 * The outcome of one read. `no-plan` is an answer from the app server — the
 * account cannot read plan limits, as an API key cannot — and is the only
 * outcome that says something about the account. `failed` is a read that broke
 * or an answer this module cannot map, and `limits` always carries at least one
 * window.
 */
export type RateLimitRead =
	| { readonly kind: 'limits'; readonly windows: RateWindows }
	| { readonly kind: 'no-plan' }
	| { readonly kind: 'failed'; readonly reason: string };

export interface RateLimitOptions {
	/** How long the handshake and the read may take together. */
	readonly timeoutMs?: number;
	readonly log?: Log;
	/** `NODE_OPTIONS` for the app server process, such as the hidden-console preload. */
	readonly nodeOptions?: string;
	/** The `CODEX_HOME` the agent runs in, so the read asks the account the agent is signed in with. */
	readonly codexHome?: string;
}

/** The handshake the pinned adapter sends; the app server refuses anything else first (probe note, question 8). */
function initializeRequest(adapterVersion: string) {
	return {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			capabilities: { experimentalApi: true, requestAttestation: false },
			clientInfo: { name: '@agentclientprotocol/codex-acp', version: adapterVersion, title: 'Codex ACP' },
		},
	};
}
const INITIALIZE_ID = 1;
/** `account/rateLimits/read` takes no parameters. */
const READ_LIMITS = { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' };
const TIMEOUT_MS = 30_000;
/**
 * Windows up to six hours are the five-hour limit; anything longer is the
 * weekly one. A window without a reported duration is bucketed by the name it
 * came under: `primary` is the short limit and `secondary` the long one.
 */
const SHORT_WINDOW_MINS = 360;
/** The code the app server answers both observed "no ChatGPT sign-in" states with (probe note, question 8). */
const NO_PLAN_CODE = -32600;

/** The app server's own answer that there is no plan to read; not a failure. */
class NoPlanError extends Error { }

/** A read that broke, with the reason the caller reports as the last refresh's failure. */
function failed(log: Log | undefined, reason: string): RateLimitRead {
	log?.(`Plan limits: ${reason}`, 'debug');
	return { kind: 'failed', reason };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const asCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Reads the plan limits of the signed-in ChatGPT account with a one-shot Codex
 * app server. Codex exposes nothing over ACP, and the app server's own
 * `/status` needs a live chat, so the numbers are read here and nowhere else.
 *
 * Nothing runs automatically: the status item's click and
 * `codexAcp.refreshUsage` are the only callers.
 */
export async function readRateLimits(adapterEntry: string, options: RateLimitOptions): Promise<RateLimitRead> {
	const { timeoutMs = TIMEOUT_MS, log } = options;
	let child: cp.ChildProcess | undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		const launcher = codexLauncher(adapterEntry);
		if (!launcher) {
			return failed(log, 'the pinned @openai/codex is not beside the installed adapter');
		}

		const result = await new Promise<unknown>((resolve, reject) => {
			const settle = (error: Error | undefined, value?: unknown) => error ? reject(error) : resolve(value);

			// The extension host is Electron, so Code.exe only behaves like node with this set.
			const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
			if (options.nodeOptions !== undefined) {
				env.NODE_OPTIONS = options.nodeOptions;
			}
			if (options.codexHome !== undefined) {
				env.CODEX_HOME = options.codexHome;
			}
			child = cp.spawn(process.execPath, [launcher, 'app-server'], {
				env,
				stdio: ['pipe', 'pipe', 'ignore'],
				windowsHide: true,
				detached: process.platform !== 'win32',
			});
			if (!child.pid) {
				settle(new Error('the app server could not be started'));
				return;
			}
			// Tracked like the agent itself, so `deactivate` takes down a read still in flight.
			trackChild(child.pid);
			child.on('error', settle);
			child.on('exit', code => settle(new Error(`the app server stopped with exit code ${String(code)}`)));
			child.stdin?.on('error', settle);

			let handshake = false;
			let buffer = '';
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				buffer += chunk;
				for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
					const line = buffer.slice(0, index).trim();
					buffer = buffer.slice(index + 1);
					const message = parseLine(line);
					// A notification carries `emittedAtMs` instead of an id.
					if (!message || message.id === undefined) {
						continue;
					}

					const error = asRecord(message.error);
					if (message.id === INITIALIZE_ID) {
						if (error) {
							settle(new Error(`the app server refused the handshake: ${String(error.message ?? 'no reason')}`));
							return;
						}
						handshake = true;
						child?.stdin?.write(`${JSON.stringify(READ_LIMITS)}\n`);
						continue;
					}

					if (handshake && message.id === READ_LIMITS.id) {
						// The message names the missing sign-in, never a credential.
						if (error && asCount(error.code) === NO_PLAN_CODE) {
							reject(new NoPlanError(String(error.message ?? 'the account cannot read plan limits')));
							return;
						}
						if (error) {
							settle(new Error(`the app server refused the read: ${String(error.message ?? 'no reason')}`));
							return;
						}
						settle(undefined, message.result);
						return;
					}
				}
			});

			timer = setTimeout(() => settle(new Error(`the app server did not answer within ${timeoutMs} ms`)), timeoutMs);
			child.stdin?.write(`${JSON.stringify(initializeRequest(options.adapterVersion))}\n`);
		});

		// A successful answer this module cannot read is a failed read: it says nothing about the account.
		const snapshot = snapshotOf(result);
		if (!snapshot) {
			return failed(log, 'the app server answered without a rate-limit snapshot');
		}
		const windows = windowsIn(snapshot);
		if (!windows) {
			return failed(log, 'the rate-limit snapshot carried no usable window');
		}
		log?.(`Plan limits: ${describe(windows)}`, 'debug');
		return { kind: 'limits', windows };
	} catch (error) {
		if (error instanceof NoPlanError) {
			log?.(`Plan limits: the app server has no plan to read: ${error.message}`, 'debug');
			return { kind: 'no-plan' };
		}
		return failed(log, error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timer);
		// killTree takes the whole tree down and drops the pid from what `deactivate` cleans up.
		if (child?.pid) {
			await killTree(child.pid);
		}
	}
}

/** The launcher of the pinned `@openai/codex` package, resolved from the adapter that depends on it. */
function codexLauncher(adapterEntry: string): string | undefined {
	try {
		const require = createRequire(adapterEntry);
		const manifest = require.resolve('@openai/codex/package.json');
		const bin = asRecord((require(manifest) as { readonly bin?: unknown }).bin)?.codex;
		if (typeof bin !== 'string') {
			return undefined;
		}
		const launcher = path.resolve(path.dirname(manifest), bin);
		return fs.existsSync(launcher) ? launcher : undefined;
	} catch {
		return undefined;
	}
}

/** One JSON value from one line, or `undefined` for anything else on the stream. */
function parseLine(line: string): Record<string, unknown> | undefined {
	if (!line.startsWith('{')) {
		return undefined;
	}
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/**
 * The snapshot the read is about: `rateLimitsByLimitId` is authoritative, with
 * `rateLimits` as the fallback. `undefined` when the answer carries neither.
 */
function snapshotOf(result: unknown): Record<string, unknown> | undefined {
	const record = asRecord(result);
	const byLimitId = asRecord(record?.rateLimitsByLimitId);
	const entries = byLimitId ? Object.values(byLimitId) : [];
	return asRecord(byLimitId?.codex ?? entries[0]) ?? asRecord(record?.rateLimits);
}

/** The windows of the snapshot, or `undefined` when neither it nor the account names one. */
function windowsIn(snapshot: Record<string, unknown>): RateWindows | undefined {
	let fiveHour: RateWindow | undefined;
	let weekly: RateWindow | undefined;
	for (const key of ['primary', 'secondary']) {
		const window = windowOf(snapshot[key]);
		if (!window) {
			continue;
		}
		// A reported duration decides the bucket; without one the name does: primary is the short window.
		const isShort = window.windowDurationMins === null ? key === 'primary' : window.windowDurationMins <= SHORT_WINDOW_MINS;
		if (isShort) {
			fiveHour ??= window;
		} else {
			weekly ??= window;
		}
	}
	return fiveHour || weekly ? { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) } : undefined;
}

function windowOf(value: unknown): RateWindow | undefined {
	const window = asRecord(value);
	const usedPercent = asCount(window?.usedPercent);
	if (!window || usedPercent === undefined) {
		return undefined;
	}
	return {
		usedPercent,
		windowDurationMins: asCount(window.windowDurationMins) ?? null,
		resetsAt: asCount(window.resetsAt) ?? null,
	};
}

function describe(windows: RateWindows): string {
	const parts = [
		windows.fiveHour ? `5-hour ${windows.fiveHour.usedPercent}%` : undefined,
		windows.weekly ? `weekly ${windows.weekly.usedPercent}%` : undefined,
	].filter(part => part !== undefined);
	return parts.length > 0 ? parts.join(', ') : 'the account has no ChatGPT plan windows';
}
