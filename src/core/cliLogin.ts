/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { SignInResult } from './auth';

const LONGEST_CODE = 2048;

export interface CliLoginOptions {
	command: string;
	args: readonly string[];
	/** Added to this process's environment. */
	env: Record<string, string>;
	/** True once the login is done although the program is still open. */
	completed?: () => boolean;
	/** How long the program may take to print the page the user opens. */
	urlTimeoutMs?: number;
	/** How long the user has to finish the login. */
	loginTimeoutMs?: number;
	spawn?: typeof nodeSpawn;
}

/** A login program run without a terminal: it prints a page to open and then reads the code that page shows. */
export interface CliLogin {
	/** The page to open, or `undefined` when the program ended or stayed silent without printing one. */
	readonly url: Promise<string | undefined>;
	/** Settles when the login ends: the program exited, was cancelled, or ran out of time. */
	readonly done: Promise<SignInResult>;
	/** Hands the pasted code to the program; false when it cannot take one. */
	submitCode(code: string): boolean;
	cancel(): void;
}

export function startCliLogin(options: CliLoginOptions): CliLogin {
	const spawn = options.spawn ?? nodeSpawn;
	let settled = false;
	let urlFound = false;
	let output = '';
	let lastError = '';
	let resolveUrl: (url: string | undefined) => void = () => { };
	let resolveDone: (result: SignInResult) => void = () => { };
	const url = new Promise<string | undefined>(resolve => { resolveUrl = resolve; });
	const done = new Promise<SignInResult>(resolve => { resolveDone = resolve; });
	let child: ChildProcess | undefined;
	const timers: NodeJS.Timeout[] = [];

	const finish = (result: SignInResult): void => {
		if (settled) {
			return;
		}
		settled = true;
		for (const timer of timers) {
			clearTimeout(timer);
			clearInterval(timer);
		}
		resolveUrl(undefined);
		resolveDone(result);
		if (child && child.exitCode === null) {
			child.kill();
		}
	};

	try {
		child = spawn(options.command, [...options.args], {
			env: { ...process.env, ...options.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (error) {
		finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
		return { url, done, submitCode: () => false, cancel: () => { } };
	}

	child.on('error', error => finish({ ok: false, message: error.message }));
	child.on('close', code => finish(code === 0 ? { ok: true } : { ok: false, message: lastError || `The login program ended with code ${code}.` }));
	child.stdin?.on('error', () => { });

	child.stdout?.on('data', (chunk: Buffer) => {
		if (urlFound) {
			return;
		}
		output += chunk.toString();
		// The URL counts once whitespace follows it, so a URL split across two reads is not taken short.
		const match = /https:\/\/\S+(?=\s)/.exec(output);
		if (match) {
			urlFound = true;
			clearTimeout(urlTimer);
			resolveUrl(match[0]);
		}
	});
	child.stderr?.on('data', (chunk: Buffer) => {
		const lines = chunk.toString().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		lastError = lines.at(-1) ?? lastError;
	});

	const urlTimer = setTimeout(() => finish({ ok: false, message: 'The login program did not print a page to open.' }), options.urlTimeoutMs ?? 20_000);
	timers.push(urlTimer, setTimeout(() => finish({ ok: false, message: 'The sign-in timed out; start it again.' }), options.loginTimeoutMs ?? 300_000));
	if (options.completed) {
		timers.push(setInterval(() => {
			if (options.completed!()) {
				finish({ ok: true });
			}
		}, 500));
	}

	return {
		url,
		done,
		submitCode(code: string): boolean {
			const clean = code.trim();
			if (settled || !urlFound || !child?.stdin?.writable || clean.length === 0 || clean.length > LONGEST_CODE || /[\r\n]/.test(clean)) {
				return false;
			}
			child.stdin.write(`${clean}\n`);
			return true;
		},
		cancel: () => finish({ ok: false, message: 'Sign-in was cancelled.' }),
	};
}
