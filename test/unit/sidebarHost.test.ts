/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { SidebarHost, type SidebarPageDeps } from '../../src/sidebar/host';
import type { AgentCardState, ControlAction, ControlState, ToWebview } from '../../src/ui/messages';
import type { ControlTransport } from '../../src/ui/transport';

function stateOf(card: Partial<AgentCardState> = {}): ControlState {
	return {
		agents: [{
			id: 'a',
			displayName: 'Agent A',
			install: 'installed',
			removable: true,
			signedIn: 'yes',
			hasSavedKey: false,
			enabled: true,
			visible: true,
			settings: [],
			usage: { status: 'idle', windows: [] },
			...card,
		}],
	};
}

function setup() {
	const sent: ControlAction[] = [];
	const listeners = new Set<(state: ControlState) => void>();
	const transport: ControlTransport = {
		send: action => { sent.push(action); },
		onState: listener => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
	const deps: SidebarPageDeps = {
		openExternal: vi.fn(async () => { }),
		copyToClipboard: vi.fn(async () => { }),
		assetUri: path => ({ path }) as never,
	};

	const posted: AgentCardState[][] = [];
	let receive: ((message: unknown) => void) | undefined;
	let disposed: (() => void) | undefined;
	const host = new SidebarHost(transport, deps);
	const webview = {
		options: {} as Record<string, unknown>,
		html: '',
		cspSource: 'csp',
		asWebviewUri: (uri: { path: string }) => uri.path,
		onDidReceiveMessage: (handler: (message: unknown) => void) => { receive = handler; return { dispose() { } }; },
		postMessage: async (message: ToWebview) => { posted.push(message.agents); return true; },
	};
	host.resolveWebviewView({
		webview,
		onDidDispose: (callback: () => void) => { disposed = callback; return { dispose() { } }; },
	} as never);

	const deliver = (state: ControlState): void => {
		for (const listener of [...listeners]) {
			listener(state);
		}
	};
	return {
		host,
		deps,
		webview,
		posted,
		sent,
		deliver,
		listening: () => listeners.size,
		receive: (message: unknown) => receive?.(message),
		dispose: () => disposed?.(),
	};
}

describe('SidebarHost', () => {
	it('builds a strict page for the webview', () => {
		const { webview } = setup();
		expect(webview.html).toContain(`script-src 'nonce-`);
		expect(webview.html).not.toContain('<script>');
	});

	it('posts every state the transport delivers', () => {
		const { deliver, posted } = setup();
		deliver(stateOf());
		deliver(stateOf({ busy: 'Installing...' }));
		expect(posted).toHaveLength(2);
		expect(posted[0][0].id).toBe('a');
		expect(posted[1][0].busy).toBe('Installing...');
	});

	it('sends the page actions over the transport', () => {
		const { receive, sent } = setup();
		receive({ type: 'install', agentId: 'a' });
		receive({ type: 'ready' });
		expect(sent).toEqual([{ type: 'install', agentId: 'a' }, { type: 'ready' }]);
	});

	it('stops listening to the transport once the view is gone', () => {
		const { deliver, posted, listening, dispose } = setup();
		expect(listening()).toBe(1);
		dispose();
		expect(listening()).toBe(0);
		deliver(stateOf());
		expect(posted).toHaveLength(0);
	});
});
