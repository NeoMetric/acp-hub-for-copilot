/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';
import type { ControlSurface } from '../engine/control/ControlService';
import { ControlPage } from '../ui/controlPage';
import type { ControlAction, ControlState } from '../ui/messages';
import type { ControlTransport } from '../ui/transport';

/** What the sidebar needs from the VS Code window around it; everything else it asks the control service. */
export interface SidebarPageDeps {
	openExternal(url: string): Promise<void>;
	copyToClipboard(text: string): Promise<void>;
	/** Uri of a file inside the extension folder, for example `dist/sidebar.js`. */
	assetUri(relativePath: string): vscode.Uri;
}

/**
 * The page as VS Code hosts it: the view that loads the bundle, and the
 * `postMessage` channel the page and the host speak over. The state the page
 * draws and the actions it sends are the shared {@link ControlPage}'s, so the
 * browser tab shows exactly what this view shows.
 */
export class SidebarHost implements vscode.WebviewViewProvider, ControlTransport {
	private readonly page: ControlPage;
	private unsubscribe: (() => void) | undefined;

	constructor(control: ControlSurface, private readonly deps: SidebarPageDeps) {
		this.page = new ControlPage(control, { openExternal: deps.openExternal, copyToClipboard: deps.copyToClipboard });
	}

	/** An action the page sent over `postMessage`. */
	send(action: ControlAction): void {
		void this.handleMessage(action);
	}

	/** Where the page's snapshots go; the view posts them over `postMessage`. */
	onState(listener: (state: ControlState) => void): () => void {
		return this.page.onState(listener);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.deps.assetUri('dist'), this.deps.assetUri('media')],
		};
		view.webview.html = this.buildHtml(view.webview);
		this.unsubscribe?.();
		const unsubscribe = this.onState(state => {
			void view.webview.postMessage({ type: 'state', ...state });
		});
		this.unsubscribe = unsubscribe;
		view.webview.onDidReceiveMessage((action: ControlAction) => { this.send(action); });
		view.onDidDispose(() => {
			unsubscribe();
			if (this.unsubscribe === unsubscribe) {
				this.unsubscribe = undefined;
			}
		});
	}

	/** Redraws the cards, for a change the host learned of outside the sidebar, such as an expired sign-in. */
	refresh(): void {
		this.page.refresh();
	}

	/** Shows the page an agent wants the user to open to sign in, opening it too; `undefined` clears it. */
	showSignInUrl(adapterId: string, prompt: { url: string; message: string } | undefined): void {
		this.page.showSignInUrl(adapterId, prompt);
	}

	async handleMessage(action: ControlAction): Promise<void> {
		await this.page.handle(action);
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
