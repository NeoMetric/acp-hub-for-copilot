/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference lib="dom" />

import type { AgentCardState, FromWebview, SettingValue, SettingView, ToWebview } from '../messages';
import { GLOBAL_SETTINGS_ID, renderCards } from '../render';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;
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
	if (action === 'install' || action === 'uninstall' || action === 'signIn' || action === 'signOut' || action === 'refreshUsage' || action === 'addAgent' || action === 'removeAgent') {
		vscode.postMessage({ type: action, agentId });
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
		vscode.postMessage({ type: 'setGlobalSetting', key: target.dataset.key, value: readSettingValue(target) });
		return;
	}
	const agentId = target.dataset.agent;
	if (!agentId) {
		return;
	}
	if (target.dataset.action === 'setEnabled' && target instanceof HTMLInputElement) {
		vscode.postMessage({ type: 'setEnabled', agentId, enabled: target.checked });
		return;
	}
	const key = target.dataset.key;
	if (key) {
		vscode.postMessage({ type: 'setSetting', agentId, key, value: readSettingValue(target) });
	}
});

window.addEventListener('message', event => {
	const message = event.data as ToWebview;
	if (message.type === 'state') {
		agents = message.agents;
		globalSettings = message.globalSettings ?? [];
		draw();
	}
});

vscode.postMessage({ type: 'ready' });
