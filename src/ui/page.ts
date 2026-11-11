/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference lib="dom" />

import { renderDocsView } from './docs';
import type { AgentCardState, ModelsView, ServerView, SettingValue, SettingView, UsageHistoryView } from './messages';
import { GLOBAL_SETTINGS_ID, renderCards, renderModels, renderNav, renderServerDown, renderServerHeader, renderServerSettings, renderUsageView, type PageView, type UsageRange } from './render';
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
	let usage: UsageHistoryView | undefined;
	let server: ServerView | undefined;
	/** Why the host reaches no server, and whether it is starting one; the page is only this while it does not. */
	let linkError: string | undefined;
	let starting = false;
	/** The port as typed in Server settings, and why it was not sent, so a redraw does not wipe either. */
	let draftPort: string | undefined;
	let portError: string | undefined;
	let notice: string | undefined;
	let refreshing = false;
	let view: PageView = 'agents';
	/** The agent whose provider and model names are inputs in the Models view, if any. */
	let editing: string | undefined;
	/** The range and the filters of the Usage view; they stay here, so changing one costs no round trip. */
	let usageRange: UsageRange = '30';
	const usageAgents = new Set<string>();
	const usageWorkspaces = new Set<string>();

	/** The agents whose API key field is open, and what was typed in each, so a redraw does not wipe it. */
	const keyEntry = new Set<string>();
	const keyDrafts = new Map<string, string>();

		function toggle(set: Set<string>, value: string | undefined, on: boolean): void {
			if (value === undefined) {
				return;
			}
			if (on) {
				set.add(value);
			} else {
				set.delete(value);
			}
		}

	function restoreKeyDrafts(): void {
		for (const input of Array.from(root.querySelectorAll?.('input[data-key-input]') ?? []) as HTMLInputElement[]) {
			if (input.dataset?.keyInput) {
				input.value = keyDrafts.get(input.dataset.agent ?? '') ?? '';
			}
		}
	}

	function saveApiKey(agentId: string): void {
		const key = keyDrafts.get(agentId) ?? '';
		keyEntry.delete(agentId);
		keyDrafts.delete(agentId);
		transport.send({ type: 'saveApiKey', agentId, key });
		draw();
	}

	function draw(): void {
		if (linkError !== undefined) {
			root.innerHTML = renderServerDown(linkError, starting);
			return;
		}
		const available = { models: models !== undefined, usage: usage !== undefined, server: server !== undefined };
		if (!available.models && !available.usage && !available.server) {
			root.innerHTML = renderCards(agents, openSettings, globalSettings, keyEntry);
			restoreKeyDrafts();
			return;
		}
		const body = view === 'models' && models
			? renderModels(models, notice, { refreshing, editing })
			: view === 'usage' && usage
				? renderUsageView(usage, { range: usageRange, agents: usageAgents, workspaces: usageWorkspaces })
				: view === 'docs'
					? renderDocsView()
					: view === 'server' && server
						? renderServerSettings(server, draftPort, portError)
						: renderCards(agents, openSettings, globalSettings, keyEntry);
		root.innerHTML = (server ? renderServerHeader(server) : '') + renderNav(view, available) + body;
		restoreKeyDrafts();
		if (editing !== undefined) {
			const input = root.querySelector?.('input[data-models]') as HTMLInputElement | null | undefined;
			input?.focus();
			input?.select();
		}
	}

	/** Sends the typed port when it is one, and otherwise keeps it in the field with the reason. */
	function saveServerPort(): void {
		const text = (draftPort ?? String(server?.savedPort ?? '')).trim();
		const port = Number(text);
		if (text === '' || !Number.isInteger(port) || port < 1 || port > 65_535) {
			portError = 'Enter a port from 1 to 65535.';
			draw();
			return;
		}
		portError = undefined;
		draftPort = undefined;
		transport.send({ type: 'setServerPort', port });
		draw();
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
		if (action === 'showAgents' || action === 'showModels' || action === 'showUsage' || action === 'showDocs' || action === 'showServer') {
			view = action === 'showModels' ? 'models' : action === 'showUsage' ? 'usage' : action === 'showDocs' ? 'docs' : action === 'showServer' ? 'server' : 'agents';
			draw();
			return;
		}
		if (action === 'saveServerPort') {
			saveServerPort();
			return;
		}
		if (action === 'restartServer') {
			transport.send({ type: 'restartServer' });
			return;
		}
		if (action === 'startServer') {
			transport.send({ type: 'startServer' });
			starting = true;
			draw();
			return;
		}
		if (action === 'setUsageRange') {
			usageRange = (target.dataset.range as UsageRange | undefined) ?? '30';
			draw();
			return;
		}
		if (action === 'setRetentionDays') {
			const input = root.querySelector?.('input[data-retention]') as HTMLInputElement | null | undefined;
			const days = Number(input?.value);
			if (Number.isFinite(days)) {
				transport.send({ type: 'setRetentionDays', days });
			}
			return;
		}
		if (action === 'refreshModels') {
			transport.send({ type: 'refreshModels' });
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
		if (action === 'showApiKey') {
			keyEntry.add(agentId);
			draw();
			(root.querySelector?.(`input[data-key-input][data-agent="${agentId}"]`) as HTMLInputElement | null | undefined)?.focus();
			return;
		}
		if (action === 'cancelApiKey') {
			keyEntry.delete(agentId);
			keyDrafts.delete(agentId);
			draw();
			return;
		}
		if (action === 'saveApiKey') {
			saveApiKey(agentId);
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

	root.addEventListener('input', event => {
		const target = event.target as HTMLInputElement;
		if (target.dataset?.keyInput && target.dataset.agent) {
			keyDrafts.set(target.dataset.agent, target.value);
		}
		if (target.dataset?.serverPort !== undefined) {
			draftPort = target.value;
		}
	});

	root.addEventListener('change', event => {
		const target = event.target as HTMLInputElement | HTMLSelectElement;
		if (target.dataset.keyInput) {
			return;
		}
		if (target.dataset.models) {
			return;
		}
		if (target.dataset.agentFilter !== undefined) {
			toggle(usageAgents, target.dataset.agentFilter, (target as HTMLInputElement).checked);
			draw();
			return;
		}
		if (target.dataset.workspaceFilter !== undefined) {
			toggle(usageWorkspaces, target.dataset.workspaceFilter, (target as HTMLInputElement).checked);
			draw();
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
		const keyAgent = (target as HTMLElement).dataset?.keyInput ? (target as HTMLElement).dataset.agent : undefined;
		if (keyAgent) {
			if (key === 'Enter') {
				saveApiKey(keyAgent);
			} else if (key === 'Escape') {
				keyEntry.delete(keyAgent);
				keyDrafts.delete(keyAgent);
				draw();
			}
			return;
		}
		if ((target as HTMLElement).dataset?.serverPort !== undefined) {
			if (key === 'Enter') {
				saveServerPort();
			}
			return;
		}
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
		usage = state.usage;
		server = state.server;
		notice = state.notice;
		refreshing = state.refreshing === true;
		linkError = state.linkError;
		starting = state.starting === true;
		draw();
	});

	transport.send({ type: 'ready' });
}
