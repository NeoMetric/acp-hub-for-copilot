/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';
import type { AgentAdapter, AgentSettings } from '../core/adapter';
import type { InstallState } from '../core/installers';
import type { UsageState } from '../core/usage';
import type { AgentCardState, FromWebview, SettingValue, SettingView, ToWebview } from './messages';

/** Everything the sidebar needs from the rest of the extension, as plain functions. */
export interface SidebarDeps {
	listAdapters(): AgentAdapter[];
	getVisibleAgents(): string[] | undefined;
	saveVisibleAgents(ids: string[]): Promise<void>;
	getInstallState(adapterId: string): Promise<InstallState>;
	/** Rejects when the install fails. */
	install(adapterId: string, onProgress: (message: string) => void): Promise<void>;
	isSignedIn(adapterId: string): Promise<boolean | undefined>;
	hasSavedKey(adapterId: string): Promise<boolean>;
	signIn(adapterId: string): Promise<{ ok: boolean; message?: string }>;
	signOut(adapterId: string): Promise<void>;
	readSettings(adapterId: string): AgentSettings;
	writeSetting(adapterId: string, key: string, value: SettingValue): Promise<void>;
	isEnabled(adapterId: string): boolean;
	setEnabled(adapterId: string, enabled: boolean): Promise<void>;
	getUsage(adapterId: string): UsageState;
	refreshUsage(adapterId: string): Promise<void>;
	onUsageChange(listener: (adapterId: string) => void): { dispose(): void };
	/** Uri of a file inside the extension folder, for example `dist/sidebar.js`. */
	assetUri(relativePath: string): vscode.Uri;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SidebarHost implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private readonly installing = new Set<string>();
	private readonly busy = new Map<string, string>();
	private readonly errors = new Map<string, string>();
	private visibleAgents: Set<string> | undefined;
	private stateVersion = 0;
	private readonly enabledWrites = new Map<string, Promise<void>>();

	constructor(private readonly deps: SidebarDeps) {
		deps.onUsageChange(() => {
			void this.postState();
		});
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.deps.assetUri('dist'), this.deps.assetUri('media')],
		};
		view.webview.html = this.buildHtml(view.webview);
		view.webview.onDidReceiveMessage((message: FromWebview) => this.handleMessage(message));
		view.onDidDispose(() => {
			this.view = undefined;
		});
	}

	async handleMessage(message: FromWebview): Promise<void> {
		if (message.type === 'ready') {
			await this.postState();
			return;
		}

		const adapter = this.deps.listAdapters().find(item => item.id === message.agentId);
		if (!adapter) {
			return;
		}

		switch (message.type) {
			case 'addAgent':
			case 'removeAgent': {
				await this.ensureVisibleAgents();
				if (message.type === 'addAgent') {
					this.visibleAgents!.add(adapter.id);
				} else {
					this.visibleAgents!.delete(adapter.id);
				}
				await this.deps.saveVisibleAgents([...this.visibleAgents!]);
				await this.postState();
				return;
			}
			case 'install':
				await this.install(adapter);
				return;
			case 'signIn':
				await this.signIn(adapter);
				return;
			case 'signOut':
				await this.runBusy(adapter, 'Signing out...', () => this.deps.signOut(adapter.id));
				return;
			case 'refreshUsage':
				await this.deps.refreshUsage(adapter.id);
				return;
			case 'setEnabled': {
				const previous = this.enabledWrites.get(adapter.id) ?? Promise.resolve();
				const write = previous.then(() => this.runBusy(adapter, undefined, () => this.deps.setEnabled(adapter.id, message.enabled)));
				this.enabledWrites.set(adapter.id, write);
				await write;
				if (this.enabledWrites.get(adapter.id) === write) {
					this.enabledWrites.delete(adapter.id);
				}
				return;
			}
			case 'setSetting':
				await this.runBusy(adapter, undefined, () => this.deps.writeSetting(adapter.id, message.key, message.value));
				return;
		}
	}

	private async install(adapter: AgentAdapter): Promise<void> {
		if (this.installing.has(adapter.id)) {
			return;
		}
		this.installing.add(adapter.id);
		this.errors.delete(adapter.id);
		this.busy.set(adapter.id, 'Installing...');
		await this.postState();
		try {
			await this.deps.install(adapter.id, message => {
				this.busy.set(adapter.id, message);
				void this.postState();
			});
		} catch (error) {
			this.errors.set(adapter.id, `Install failed: ${errorText(error)}`);
		}
		this.installing.delete(adapter.id);
		this.busy.delete(adapter.id);
		await this.postState();
	}

	private async signIn(adapter: AgentAdapter): Promise<void> {
		await this.runBusy(adapter, 'Signing in...', async () => {
			const result = await this.deps.signIn(adapter.id);
			if (!result.ok) {
				throw new Error(result.message ?? 'Sign-in did not complete.');
			}
		});
	}

	/** Runs one operation on a card, showing the busy text and turning a failure into the card's error line. */
	private async runBusy(adapter: AgentAdapter, busyText: string | undefined, operation: () => Promise<void>): Promise<void> {
		this.errors.delete(adapter.id);
		if (busyText) {
			this.busy.set(adapter.id, busyText);
			await this.postState();
		}
		try {
			await operation();
		} catch (error) {
			this.errors.set(adapter.id, errorText(error));
		}
		this.busy.delete(adapter.id);
		await this.postState();
	}

	private async buildCard(adapter: AgentAdapter): Promise<AgentCardState> {
		const installState = await this.deps.getInstallState(adapter.id);
		const signedIn = await this.deps.isSignedIn(adapter.id);
		const hasSavedKey = await this.deps.hasSavedKey(adapter.id);
		const usage = this.deps.getUsage(adapter.id);
		const settings = this.deps.readSettings(adapter.id);

		const settingViews: SettingView[] = adapter.settings.map(spec => ({
			key: spec.key,
			label: spec.label,
			description: spec.description,
			type: spec.type,
			value: settings[spec.key] ?? spec.default,
			options: spec.options,
			optionDescriptions: spec.optionDescriptions,
		}));

		return {
			id: adapter.id,
			displayName: adapter.displayName,
			install: this.installing.has(adapter.id) ? 'installing' : installState,
			signedIn: signedIn === undefined ? 'unknown' : signedIn ? 'yes' : 'no',
			hasSavedKey,
			enabled: this.deps.isEnabled(adapter.id),
			visible: this.visibleAgents!.has(adapter.id),
			settings: settingViews,
			usage: {
				status: usage.status,
				windows: [...(usage.reading?.windows ?? []), ...usage.extraWindows,
					...(usage.lastModelCall ? [{ label: 'Last model call cache hit rate', usedPercent: usage.lastModelCall.hitRate }] : [])],
				plan: usage.reading?.plan,
				note: usage.reading?.note,
				error: usage.error,
				fetchedAt: usage.fetchedAt,
			},
			busy: this.busy.get(adapter.id),
			error: this.errors.get(adapter.id),
		};
	}

	private async ensureVisibleAgents(): Promise<void> {
		if (this.visibleAgents) {
			return;
		}
		const saved = this.deps.getVisibleAgents();
		if (saved) {
			this.visibleAgents = new Set(saved);
			return;
		}
		const installed: string[] = [];
		for (const adapter of this.deps.listAdapters()) {
			if (await this.deps.getInstallState(adapter.id) === 'installed') {
				installed.push(adapter.id);
			}
		}
		this.visibleAgents ??= new Set(installed);
		await this.deps.saveVisibleAgents([...this.visibleAgents]);
	}

	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}
		const version = ++this.stateVersion;
		await this.ensureVisibleAgents();
		const agents: AgentCardState[] = [];
		for (const adapter of this.deps.listAdapters()) {
			agents.push(await this.buildCard(adapter));
		}
		if (version !== this.stateVersion || !this.view) {
			return;
		}
		const message: ToWebview = { type: 'state', agents };
		await this.view.webview.postMessage(message);
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(this.deps.assetUri('dist/sidebar.js'));
		const style = webview.asWebviewUri(this.deps.assetUri('media/sidebar.css'));
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>ACP Hub</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
