/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference lib="dom" />

import type { FromWebview, SettingValue, ToWebview } from '../messages';
import { renderCards } from '../render';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

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
	if (action === 'install' || action === 'signIn' || action === 'signOut' || action === 'refreshUsage') {
		vscode.postMessage({ type: action, agentId });
	}
});

root.addEventListener('change', event => {
	const target = event.target as HTMLInputElement | HTMLSelectElement;
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
		root.innerHTML = renderCards(message.agents);
	}
});

vscode.postMessage({ type: 'ready' });
