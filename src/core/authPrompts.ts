import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentAdapter, AuthMethodSpec } from './adapter';
import { validateApiKey, type SignInChoice, type TerminalOptions } from './auth';

interface ChoiceItem extends vscode.QuickPickItem {
	choice: 'api-key' | AuthMethodSpec;
}

/** Asks for an API key; `undefined` when the box is dismissed. */
export async function askForApiKey(adapter: AgentAdapter, keyPrefix?: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title: `${adapter.displayName}: API key`,
		prompt: "Paste an API key. It is stored in VS Code's secret storage.",
		password: true,
		ignoreFocusOut: true,
		validateInput: text => {
			const problem = validateApiKey(text, keyPrefix);
			if (!problem) {
				return undefined;
			}
			const severity = problem.severity === 'error'
				? vscode.InputBoxValidationSeverity.Error
				: vscode.InputBoxValidationSeverity.Warning;
			return { message: problem.message, severity };
		},
	});
	const key = value?.trim();
	return key ? key : undefined;
}

/**
 * Lets the user pick how to sign in. `terminalMethods` are the browser
 * sign-ins to offer (see `terminalMethodsFrom`). `undefined` when dismissed.
 */
export async function pickSignInChoice(adapter: AgentAdapter, terminalMethods: AuthMethodSpec[]): Promise<SignInChoice | undefined> {
	const items: ChoiceItem[] = [];
	let keyPrefix: string | undefined;

	for (const method of terminalMethods) {
		items.push({ label: method.label, description: 'browser sign-in', choice: method });
	}
	for (const method of adapter.auth) {
		if (method.kind === 'oauth-browser' && !method.terminalCommand) {
			items.push({ label: method.label, description: 'browser sign-in', choice: method });
		}
		if (method.kind === 'api-key') {
			keyPrefix = method.keyPrefix;
			items.push({ label: method.label, description: 'pay per token', choice: 'api-key' });
		}
	}

	const picked = await vscode.window.showQuickPick(items, {
		title: `${adapter.displayName}: how do you want to sign in?`,
		placeHolder: 'Choose a sign-in method',
		ignoreFocusOut: true,
	});
	if (!picked) {
		return undefined;
	}
	if (picked.choice !== 'api-key') {
		if (picked.choice.kind === 'oauth-browser' && !picked.choice.terminalCommand) {
			return { kind: 'browser', method: picked.choice };
		}
		return { kind: 'terminal', method: picked.choice };
	}

	const key = await askForApiKey(adapter, keyPrefix);
	if (!key) {
		return undefined;
	}
	return { kind: 'api-key', key };
}

/**
 * Runs the program for the user and tells the extension when it exits, because a
 * terminal stays open after its process ends and would otherwise hold the sign-in up.
 */
const WRAPPER_SOURCE = `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [marker, program, ...args] = process.argv.slice(2);
const finish = code => { fs.writeFileSync(marker, String(code)); process.exit(code); };
const child = spawn(program, args, { stdio: 'inherit' });
child.on('error', () => finish(1));
child.on('exit', code => finish(code ?? 1));
`;

const MARKER_POLL_MS = 500;

/**
 * The real terminal runner: shows a terminal and resolves when its program exits or the
 * terminal is closed, whichever comes first. A terminal whose program succeeded is closed.
 */
export async function runInVsCodeTerminal(options: TerminalOptions, storageDir: string): Promise<void> {
	await fs.promises.mkdir(storageDir, { recursive: true });
	const wrapper = path.join(storageDir, 'sign-in-terminal.cjs');
	await fs.promises.writeFile(wrapper, WRAPPER_SOURCE, 'utf8');
	const marker = path.join(storageDir, `sign-in-${randomBytes(6).toString('hex')}.done`);

	return new Promise<void>(resolve => {
		const { completed, ...terminalOptions } = options;
		const terminal = vscode.window.createTerminal({
			...terminalOptions,
			shellPath: process.execPath,
			shellArgs: [wrapper, marker, options.shellPath, ...options.shellArgs],
		});
		let finished = false;
		const finish = () => {
			if (finished) {
				return;
			}
			finished = true;
			clearInterval(poll);
			listener.dispose();
			fs.rmSync(marker, { force: true });
			resolve();
		};
		const poll = setInterval(() => {
			if (completed?.()) {
				finish();
				terminal.dispose();
				return;
			}
			const exitCode = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
			if (!exitCode) {
				return;
			}
			finish();
			if (exitCode === '0') {
				terminal.dispose();
			}
		}, MARKER_POLL_MS);
		const listener = vscode.window.onDidCloseTerminal(closed => {
			if (closed === terminal) {
				finish();
			}
		});
		terminal.show();
	});
}
