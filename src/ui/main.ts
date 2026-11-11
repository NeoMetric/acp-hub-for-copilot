/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference lib="dom" />

import type { ControlAction } from './messages';
import { mountPage } from './page';
import { createHttpTransport, createWebviewTransport, type ControlTransport } from './transport';

/** VS Code injects this into a webview; a page served by the HTTP host has none. */
declare function acquireVsCodeApi(): { postMessage(message: ControlAction): void };

/**
 * The same bundle runs in a webview and in a browser tab: in a webview VS Code's
 * `postMessage` carries the messages, and anywhere else the server's routes do.
 */
function transportOf(): ControlTransport {
	if (typeof acquireVsCodeApi === 'function') {
		const vscode = acquireVsCodeApi();
		return createWebviewTransport({
			postMessage: message => vscode.postMessage(message),
			onMessage: listener => window.addEventListener('message', event => listener(event.data)),
		});
	}
	return createHttpTransport({
		fetch: (input, init) => fetch(input, init),
		eventSource: url => new EventSource(url),
	});
}

mountPage(transportOf(), document.getElementById('root') as HTMLElement);
