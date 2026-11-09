/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';
import type { ControlAction } from '../ui/messages';
import type { ControlTransport } from '../ui/transport';

/** What the sidebar needs from the VS Code window around it; everything else it asks the server. */
export interface SidebarPageDeps {
	openExternal(url: string): Promise<void>;
	copyToClipboard(text: string): Promise<void>;
	/** Uri of a file inside the extension folder, for example `dist/sidebar.js`. */
	assetUri(relativePath: string): vscode.Uri;
}

/**
 * The page as VS Code hosts it: the view that loads the bundle, and the
 * `postMessage` channel the page and the host speak over. The transport it
 * draws from is the relay to the server, so the browser tab shows exactly what
 * this view shows.
 */
export class SidebarHost implements vscode.WebviewViewProvider {
	private unsubscribe: (() => void) | undefined;

	constructor(private readonly transport: ControlTransport, private readonly deps: SidebarPageDeps) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.deps.assetUri('dist'), this.deps.assetUri('media')],
		};
		view.webview.html = this.buildHtml(view.webview);
		this.unsubscribe?.();
		const unsubscribe = this.transport.onState(state => {
			void view.webview.postMessage({ type: 'state', ...state });
		});
		this.unsubscribe = unsubscribe;
		view.webview.onDidReceiveMessage((action: ControlAction) => { this.transport.send(action); });
		view.onDidDispose(() => {
			unsubscribe();
			if (this.unsubscribe === unsubscribe) {
				this.unsubscribe = undefined;
			}
		});
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
