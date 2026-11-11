/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ControlAction, ControlState, ServerView } from '../../src/ui/messages';
import { mountPage } from '../../src/ui/page';
import type { ControlTransport } from '../../src/ui/transport';

const SERVER: ServerView = { port: 8791, savedPort: 8791, url: 'http://127.0.0.1:8791/?token=abc', portFromEnv: false, alive: true };
const STATE: ControlState = { agents: [], server: SERVER };

/** The page's root without a DOM: it keeps the HTML it was given and the listeners it was wired with. */
class FakeRoot {
	innerHTML = '';
	private readonly listeners = new Map<string, (event: unknown) => void>();

	addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, listener);
	}

	fire(type: string, target: unknown, extra: object = {}): void {
		this.listeners.get(type)?.({ target, ...extra });
	}
}

function mount(state: ControlState) {
	const sent: ControlAction[] = [];
	let deliver: (state: ControlState) => void = () => undefined;
	const transport = {
		send: (action: ControlAction) => { sent.push(action); },
		onState: (listener: (state: ControlState) => void) => { deliver = listener; return () => undefined; },
	} as ControlTransport;
	const root = new FakeRoot();
	mountPage(transport, root as unknown as HTMLElement);
	deliver(state);
	const button = (action: string) => ({ closest: () => ({ disabled: false, dataset: { action } }) });
	const type = (value: string) => root.fire('input', { dataset: { serverPort: 'true' }, value });
	return { root, sent, button, deliver, type };
}

describe('the server header and views of the page', () => {
	it('draws the header and the nav, with Docs and Server settings, when the host has a server', () => {
		const { root } = mount(STATE);

		expect(root.innerHTML).toContain('class="server-link"');
		expect(root.innerHTML).toContain('data-action="showDocs"');
		expect(root.innerHTML).toContain('data-action="showServer"');
		expect(root.innerHTML.indexOf('server-status')).toBeLessThan(root.innerHTML.indexOf('page-nav'));
	});

	it('keeps the header on every view', () => {
		const { root, button } = mount(STATE);

		root.fire('click', button('showDocs'));
		expect(root.innerHTML).toContain('class="server-link"');
		expect(root.innerHTML).toContain('docs-view');

		root.fire('click', button('showServer'));
		expect(root.innerHTML).toContain('class="server-link"');
		expect(root.innerHTML).toContain('data-server-port');
	});

	it('draws the header red when the state says the server is gone', () => {
		const { root, deliver } = mount(STATE);

		deliver({ ...STATE, server: { ...SERVER, alive: false } });

		expect(root.innerHTML).toContain('status-dot down');
		expect(root.innerHTML).not.toContain('status-dot alive');
	});

	it('sends the port that was typed when Save is clicked', () => {
		const { root, sent, button, type } = mount(STATE);
		root.fire('click', button('showServer'));

		type('9100');
		root.fire('click', button('saveServerPort'));

		expect(sent).toContainEqual({ type: 'setServerPort', port: 9100 });
	});

	it('keeps a half-typed port through a redraw', () => {
		const { root, button, deliver, type } = mount(STATE);
		root.fire('click', button('showServer'));

		type('91');
		deliver({ ...STATE, server: { ...SERVER } });

		expect(root.innerHTML).toMatch(/data-server-port[^>]*value="91"/);
	});

	it.each(['', '0', '70000', '80.5', 'abc'])('sends nothing and says so when the port is "%s"', draft => {
		const { root, sent, button, type } = mount(STATE);
		root.fire('click', button('showServer'));

		type(draft);
		sent.length = 0;
		root.fire('click', button('saveServerPort'));

		expect(sent).toEqual([]);
		expect(root.innerHTML).toContain('Enter a port from 1 to 65535.');
	});

	it('sends restartServer when Restart is clicked', () => {
		const { root, sent, button } = mount(STATE);
		root.fire('click', button('showServer'));

		sent.length = 0;
		root.fire('click', button('restartServer'));

		expect(sent).toEqual([{ type: 'restartServer' }]);
	});
});

describe('a page whose host reaches no server', () => {
	const DOWN: ControlState = { agents: [], linkError: 'The server on port 8791 is not running.' };

	it('says so, with the reason and a button to start one, instead of cards and tabs', () => {
		const { root } = mount(DOWN);

		expect(root.innerHTML).toContain('Server not running');
		expect(root.innerHTML).toContain('The server on port 8791 is not running.');
		expect(root.innerHTML).toContain('data-action="startServer"');
		expect(root.innerHTML).not.toContain('page-nav');
	});

	it('sends startServer when the button is clicked, and says it is starting', () => {
		const { root, sent, button } = mount(DOWN);
		sent.length = 0;

		root.fire('click', button('startServer'));

		expect(sent).toEqual([{ type: 'startServer' }]);
		expect(root.innerHTML).toContain('Starting…');
		expect(root.innerHTML).toMatch(/data-action="startServer" disabled/);
	});

	it('draws the header and the cards again once the server answers', () => {
		const { root, deliver } = mount(DOWN);

		deliver(STATE);

		expect(root.innerHTML).toContain('class="server-link"');
		expect(root.innerHTML).not.toContain('Server not running');
	});
});
