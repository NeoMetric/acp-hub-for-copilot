/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UsageWindow } from '../core/adapter';
import type { AgentCardState, SettingView } from './messages';

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(100, Math.max(0, Math.round(value)));
}

function renderSetting(agentId: string, setting: SettingView): string {
	const attributes = `data-agent="${escapeHtml(agentId)}" data-key="${escapeHtml(setting.key)}" data-type="${setting.type}" title="${escapeHtml(setting.description)}"`;
	const label = `<span class="setting-label">${escapeHtml(setting.label)}</span>`;

	if (setting.type === 'boolean') {
		const checked = setting.value === true ? ' checked' : '';
		return `<label class="setting"><input type="checkbox" ${attributes}${checked}> ${label}</label>`;
	}

	if (setting.type === 'enum') {
		const options = setting.options ?? [];
		const optionDescriptions = setting.optionDescriptions ?? [];
		const items = options.map((option, index) => {
			const selected = option === setting.value ? ' selected' : '';
			const description = optionDescriptions[index] ? ` title="${escapeHtml(optionDescriptions[index])}"` : '';
			return `<option value="${escapeHtml(option)}"${description}${selected}>${escapeHtml(option)}</option>`;
		}).join('');
		return `<label class="setting">${label}<select ${attributes}>${items}</select></label>`;
	}

	if (setting.type === 'number') {
		return `<label class="setting">${label}<input type="number" ${attributes} value="${escapeHtml(String(setting.value))}"></label>`;
	}

	const text = Array.isArray(setting.value) ? setting.value.join(', ') : String(setting.value);
	return `<label class="setting">${label}<input type="text" ${attributes} value="${escapeHtml(text)}"></label>`;
}

function renderWindow(window: UsageWindow): string {
	const percent = clampPercent(window.usedPercent);
	const resets = window.resets ? `<span class="resets">resets ${escapeHtml(window.resets)}</span>` : '';
	return `<div class="usage-window">`
		+ `<div class="usage-head"><span>${escapeHtml(window.label)}</span><span>${percent}%</span></div>`
		+ `<div class="bar"><div class="bar-fill" style="width:${percent}%"></div></div>`
		+ resets
		+ `</div>`;
}

function renderUsage(agent: AgentCardState): string {
	const usage = agent.usage;
	if (usage.status === 'unsupported') {
		return '';
	}

	const parts: string[] = [];
	if (usage.plan) {
		parts.push(`<div class="plan">Plan: ${escapeHtml(usage.plan)}</div>`);
	}
	for (const window of usage.windows) {
		parts.push(renderWindow(window));
	}
	if (usage.status === 'loading') {
		parts.push('<div class="note">Loading usage...</div>');
	}
	if (usage.note) {
		parts.push(`<div class="note">${escapeHtml(usage.note)}</div>`);
	}
	if (usage.error) {
		parts.push(`<div class="error">${escapeHtml(usage.error)}</div>`);
	}

	const refresh = `<button class="link" data-action="refreshUsage" data-agent="${escapeHtml(agent.id)}">Refresh usage</button>`;
	return `<div class="usage">${parts.join('')}${refresh}</div>`;
}

function renderInstall(agent: AgentCardState): string {
	const id = escapeHtml(agent.id);
	if (agent.install === 'installed') {
		return '<span class="badge">Installed</span>';
	}
	if (agent.install === 'installing') {
		return '<button disabled>Installing...</button>';
	}
	return `<button data-action="install" data-agent="${id}">Install</button>`;
}

function renderAccount(agent: AgentCardState): string {
	const id = escapeHtml(agent.id);
	const disabled = agent.install !== 'installed' || agent.busy ? ' disabled' : '';
	if (agent.signedIn === 'yes') {
		return `<button class="secondary" data-action="signOut" data-agent="${id}"${disabled}>Sign out</button>`;
	}
	return `<button data-action="signIn" data-agent="${id}"${disabled}>Sign in</button>`;
}

function renderCard(agent: AgentCardState): string {
	const id = escapeHtml(agent.id);
	const checked = agent.enabled ? ' checked' : '';
	const busy = agent.busy ? `<div class="note">${escapeHtml(agent.busy)}</div>` : '';
	const error = agent.error ? `<div class="error">${escapeHtml(agent.error)}</div>` : '';
	const settings = agent.settings.map(setting => renderSetting(agent.id, setting)).join('');

	return `<section class="card" data-agent="${id}">`
		+ `<div class="card-head"><h2>${escapeHtml(agent.displayName)}</h2>`
		+ `<label class="toggle"><input type="checkbox" data-action="setEnabled" data-agent="${id}"${checked}> Enabled</label></div>`
		+ `<div class="actions">${renderInstall(agent)}${renderAccount(agent)}</div>`
		+ busy
		+ error
		+ renderUsage(agent)
		+ (settings ? `<div class="settings">${settings}</div>` : '')
		+ `</section>`;
}

export function renderCards(agents: AgentCardState[]): string {
	const cards = agents.map(renderCard).join('');
	const addAgent = '<section class="add-agent"><h2>Add agent</h2>'
		+ '<div class="note">More agents from the ACP registry come in a future release.</div></section>';
	return cards + addAgent;
}
