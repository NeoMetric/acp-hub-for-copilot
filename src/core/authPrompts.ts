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
		return { kind: 'terminal', method: picked.choice };
	}

	const key = await askForApiKey(adapter, keyPrefix);
	if (!key) {
		return undefined;
	}
	return { kind: 'api-key', key };
}

/** The real terminal runner: shows a terminal and resolves when it is closed. */
export function runInVsCodeTerminal(options: TerminalOptions): Promise<void> {
	return new Promise<void>(resolve => {
		const terminal = vscode.window.createTerminal(options);
		const listener = vscode.window.onDidCloseTerminal(closed => {
			if (closed !== terminal) {
				return;
			}
			listener.dispose();
			resolve();
		});
		terminal.show();
	});
}
