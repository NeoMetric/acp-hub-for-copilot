import { describe, expect, it } from 'vitest';
import type { ControlAction, ControlState, ModelsView } from '../../src/ui/messages';
import { mountPage } from '../../src/ui/page';
import { renderModels } from '../../src/ui/render';
import type { ControlTransport } from '../../src/ui/transport';

const VIEW: ModelsView = {
	agents: [{
		agentId: 'claude',
		provider: { name: 'Work Claude', default: 'Claude Agent' },
		models: [{ value: 'sonnet', name: 'Sonnet 5.5', default: 'Sonnet 5.5' }, { value: 'opus', name: 'Fast one', default: 'Opus 5' }],
	}],
};

describe('renderModels', () => {
	it('shows the names as text with one pencil, beside the provider name', () => {
		const html = renderModels(VIEW);

		expect(html).not.toContain('<input');
		expect(html).toContain('Work Claude');
		expect(html).toContain('Fast one');
		expect(html.match(/data-action="editNames"/g)).toHaveLength(1);
		expect(html).toContain('data-action="editNames" data-agent="claude"');
		expect(html).toContain('data-action="refreshModels"');
	});

	it('shows the agent\'s own name beside a name the user chose, and nothing beside one they did not', () => {
		const html = renderModels(VIEW);

		expect(html).toContain('<span class="muted">Opus 5</span>');
		expect(html).toContain('<span class="muted">Claude Agent</span>');
		expect(html).not.toContain('<span class="muted">Sonnet 5.5</span>');
	});

	it('turns the provider name and every model name of the agent into inputs, holding only chosen names', () => {
		const html = renderModels(VIEW, undefined, { editing: 'claude' });

		expect(html.match(/<input/g)).toHaveLength(3);
		expect(html).not.toContain('data-action="editNames"');
		expect(html).toContain('data-action="saveNames" data-agent="claude"');
		expect(html).toContain('data-action="cancelNames" data-agent="claude"');
		expect(html).toContain('data-models="provider" data-agent="claude" value="Work Claude" placeholder="Claude Agent"');
		expect(html).toContain('data-models="model" data-agent="claude" data-model="opus" value="Fast one" placeholder="Opus 5"');
		expect(html).toContain('data-model="sonnet" value="" placeholder="Sonnet 5.5"');
		expect(renderModels(VIEW, undefined, { editing: 'other' })).not.toContain('<input');
	});
	it('escapes names and the notice', () => {
		const view = { agents: [{ agentId: 'a', provider: { name: '<b>&"', default: 'A' }, models: [] }] };
		const html = renderModels(view, '<script>alert(1)</script>\nsecond line');

		expect(html).not.toContain('<b>');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;b&gt;&amp;&quot;');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>second line');
		expect(renderModels(view, undefined, { editing: 'a' })).toContain('value="&lt;b&gt;&amp;&quot;"');
	});

	it('shows a progress bar and disables Refresh while the models are being fetched', () => {
		const html = renderModels(VIEW, undefined, { refreshing: true });

		expect(html).toContain('<progress');
		expect(html).toContain('Fetching models');
		expect(html).toMatch(/<button[^>]*data-action="refreshModels"[^>]*disabled/);
		expect(renderModels(VIEW)).not.toContain('<progress');
		expect(renderModels(VIEW)).not.toMatch(/data-action="refreshModels"[^>]*disabled/);
	});

	it('tells the user to refresh when an agent has no models yet', () => {
		const html = renderModels({ agents: [{ agentId: 'a', provider: { name: 'A', default: 'A' }, models: [] }] });

		expect(html).toContain('No models yet; press Refresh to load them.');
		expect(renderModels(VIEW)).not.toContain('No models yet');
	});

	it('shows the notice in a status region', () => {
		expect(renderModels(VIEW, 'Reload it.')).toContain('role="status"');
		expect(renderModels(VIEW)).not.toContain('role="status"');
	});
});

/** The page's root without a DOM: it keeps the HTML it was given and the listeners it was wired with. */
class FakeRoot {
	innerHTML = '';
	inputs: unknown[] = [];
	private readonly listeners = new Map<string, (event: unknown) => void>();

	addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, listener);
	}

	querySelectorAll(): unknown[] {
		return this.inputs;
	}

	fire(type: string, target: unknown, extra: object = {}): void {
		this.listeners.get(type)?.({ target, ...extra });
	}
}

function mount(state: ControlState) {
	const sent: ControlAction[] = [];
	let deliver: (state: ControlState) => void = () => undefined;
	const transport: ControlTransport = {
		send: action => { sent.push(action); },
		onState: listener => { deliver = listener; return () => undefined; },
	} as ControlTransport;
	const root = new FakeRoot();
	mountPage(transport, root as unknown as HTMLElement);
	deliver(state);
	const button = (action: string, extra: Record<string, string> = {}) => ({ closest: () => ({ disabled: false, dataset: { action, ...extra } }) });
	return { root, sent, button, deliver };
}

describe('the Models view of the page', () => {
	const STATE: ControlState = { agents: [], models: VIEW, notice: 'Reload it.' };

	it('offers the Models view only when the host has models, and switches to it', () => {
		const withoutModels = mount({ agents: [] });
		expect(withoutModels.root.innerHTML).not.toContain('showModels');

		const { root, button } = mount(STATE);
		expect(root.innerHTML).toContain('data-action="showModels"');
		expect(root.innerHTML).not.toContain('editNames');

		root.fire('click', button('showModels'));

		expect(root.innerHTML).toContain('data-action="editNames"');
		expect(root.innerHTML).toContain('Reload it.');
	});

	it('sends refreshModels when Refresh is clicked', () => {
		const { root, sent, button } = mount(STATE);
		root.fire('click', button('showModels'));

		root.fire('click', button('refreshModels'));

		expect(sent).toContainEqual({ type: 'refreshModels' });
	});

	it('opens the inputs when the pencil is clicked, and drops them on Cancel or Escape', () => {
		const { root, button } = mount(STATE);
		root.fire('click', button('showModels'));

		root.fire('click', button('editNames', { agent: 'claude' }));
		expect(root.innerHTML.match(/<input/g)).toHaveLength(3);

		root.fire('click', button('cancelNames', { agent: 'claude' }));
		expect(root.innerHTML).not.toContain('<input');

		root.fire('click', button('editNames', { agent: 'claude' }));
		root.fire('keydown', { dataset: { models: 'model' } }, { key: 'Escape' });
		expect(root.innerHTML).not.toContain('<input');
	});

	it('sends the names that changed, and only those, on Save or Enter, and closes the inputs', () => {
		const { root, sent, button } = mount(STATE);
		const input = (dataset: Record<string, string>, value: string, defaultValue: string) => ({ dataset, value, defaultValue });
		root.inputs = [
			input({ models: 'provider', agent: 'claude' }, 'Mine', 'Work Claude'),
			input({ models: 'model', agent: 'claude', model: 'sonnet' }, '', ''),
			input({ models: 'model', agent: 'claude', model: 'opus' }, '', 'Fast one'),
		];
		root.fire('click', button('showModels'));
		root.fire('click', button('editNames', { agent: 'claude' }));
		sent.length = 0;

		root.fire('click', button('saveNames', { agent: 'claude' }));

		expect(sent).toEqual([
			{ type: 'setProviderName', agentId: 'claude', name: 'Mine' },
			{ type: 'setModelName', agentId: 'claude', model: 'opus', name: '' },
		]);
		expect(root.innerHTML).not.toContain('<input');

		sent.length = 0;
		root.fire('click', button('editNames', { agent: 'claude' }));
		root.fire('keydown', { dataset: { models: 'provider' } }, { key: 'Enter' });
		expect(sent).toHaveLength(2);
		expect(root.innerHTML).not.toContain('<input');
	});
	it('shows the progress bar while the host reports that it is refreshing', () => {
		const { root, button, deliver } = mount(STATE);
		root.fire('click', button('showModels'));

		deliver({ ...STATE, refreshing: true });

		expect(root.innerHTML).toContain('<progress');
	});
});
