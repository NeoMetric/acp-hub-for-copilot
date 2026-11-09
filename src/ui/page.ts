/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference lib="dom" />

import type { AgentCardState, SettingValue, SettingView } from './messages';
import { GLOBAL_SETTINGS_ID, renderCards } from './render';
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

	function draw(): void {
		root.innerHTML = renderCards(agents, openSettings, globalSettings);
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

	transport.onState(state => {
		agents = state.agents;
		globalSettings = state.globalSettings ?? [];
		draw();
	});

	transport.send({ type: 'ready' });
}
