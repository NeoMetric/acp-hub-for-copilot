/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference lib="dom" />

import type { AgentCardState, ModelsView, SettingValue, SettingView } from './messages';
import { GLOBAL_SETTINGS_ID, renderCards, renderModels, renderNav, type PageView } from './render';
import type { ControlTransport } from './transport';

/**
 * The page itself, with no host in it: it draws what the transport hands it and
 * sends what the user does back over the same transport. A webview view and a
 * browser tab differ only in the transport build, never here.
 */
export function mountPage(transport: ControlTransport, root: HTMLElement): void {
	const openSettings = new Set<string>();
	let agents: AgentCardState[] = [];
	let globalSettings: SettingView[] = [];
	let models: ModelsView | undefined;
	let notice: string | undefined;
	let syncing = false;
	let view: PageView = 'agents';
	/** The agent whose provider and model names are inputs in the Models view, if any. */
	let editing: string | undefined;

	function draw(): void {
		if (!models) {
			root.innerHTML = renderCards(agents, openSettings, globalSettings);
			return;
		}
		root.innerHTML = renderNav(view) + (view === 'models' ? renderModels(models, notice, { syncing, editing }) : renderCards(agents, openSettings, globalSettings));
		if (editing !== undefined) {
			const input = root.querySelector?.('input[data-models]') as HTMLInputElement | null | undefined;
			input?.focus();
			input?.select();
		}
	}

	function stopEditing(): void {
		if (editing !== undefined) {
			editing = undefined;
			draw();
		}
	}

	/** Sends each name that was changed in the inputs being edited, then turns them back into text. */
	function saveNames(): void {
		const inputs = Array.from(root.querySelectorAll?.('input[data-models]') ?? []) as HTMLInputElement[];
		for (const input of inputs) {
			if (input.value === input.defaultValue) {
				continue;
			}
			const { models: kind, agent, model } = input.dataset;
			if (kind === 'provider' && agent) {
				transport.send({ type: 'setProviderName', agentId: agent, name: input.value });
			} else if (kind === 'model' && agent && model !== undefined) {
				transport.send({ type: 'setModelName', agentId: agent, model, name: input.value });
			}
		}
		stopEditing();
	}

	function readSettingValue(input: HTMLInputElement | HTMLSelectElement): SettingValue {
		const type = input.dataset.type;
		if (type === 'boolean' && input instanceof HTMLInputElement) {
			return input.checked;
		}
		if (type === 'number') {
			return Number(input.value);
		}
		if (type === 'string-list') {
			return input.value.split(',').map(item => item.trim()).filter(item => item.length > 0);
		}
		return input.value;
	}

	root.addEventListener('click', event => {
		const target = (event.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
		if (!target || target.disabled) {
			return;
		}
		const action = target.dataset.action;
		const agentId = target.dataset.agent ?? '';
		if (action === 'showAgents' || action === 'showModels') {
			view = action === 'showModels' ? 'models' : 'agents';
			draw();
			return;
		}
		if (action === 'syncModels') {
			transport.send({ type: 'syncModels' });
			return;
		}
		if (action === 'editNames') {
			editing = agentId;
			draw();
			return;
		}
		if (action === 'saveNames') {
			saveNames();
			return;
		}
		if (action === 'cancelNames') {
			stopEditing();
			return;
		}
		if (action === 'toggleSettings') {
			if (!openSettings.delete(agentId)) {
				openSettings.add(agentId);
			}
			draw();
			return;
		}
		if (action === 'install' || action === 'uninstall' || action === 'signIn' || action === 'signOut' || action === 'refreshUsage' || action === 'copySignInUrl' || action === 'openSignInUrl' || action === 'addAgent' || action === 'removeAgent') {
			transport.send({ type: action, agentId });
		}
	});

	root.addEventListener('toggle', event => {
		const target = event.target as HTMLElement;
		if (target instanceof HTMLDetailsElement && target.classList.contains('global-settings')) {
			if (target.open) {
				openSettings.add(GLOBAL_SETTINGS_ID);
			} else {
				openSettings.delete(GLOBAL_SETTINGS_ID);
			}
		}
	}, true);

	root.addEventListener('change', event => {
		const target = event.target as HTMLInputElement | HTMLSelectElement;
		if (target.dataset.models) {
			return;
		}
		if (target.dataset.global && target.dataset.key) {
			transport.send({ type: 'setGlobalSetting', key: target.dataset.key, value: readSettingValue(target) });
			return;
		}
		const agentId = target.dataset.agent;
		if (!agentId) {
			return;
		}
		if (target.dataset.action === 'setEnabled' && target instanceof HTMLInputElement) {
			transport.send({ type: 'setEnabled', agentId, enabled: target.checked });
			return;
		}
		const key = target.dataset.key;
		if (key) {
			transport.send({ type: 'setSetting', agentId, key, value: readSettingValue(target) });
		}
	});

	// Enter saves the names being edited and Escape drops them.
	root.addEventListener('keydown', event => {
		const { key, target } = event as KeyboardEvent;
		if (!(target as HTMLElement).dataset?.models) {
			return;
		}
		if (key === 'Enter') {
			saveNames();
		} else if (key === 'Escape') {
			stopEditing();
		}
	});

	transport.onState(state => {
		agents = state.agents;
		globalSettings = state.globalSettings ?? [];
		models = state.models;
		notice = state.notice;
		syncing = state.syncing === true;
		draw();
	});

	transport.send({ type: 'ready' });
}
