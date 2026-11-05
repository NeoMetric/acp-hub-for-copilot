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

function renderInfo(label: string, description: string): string {
	return `<details class="setting-info"><summary aria-label="About ${escapeHtml(label)}">ⓘ</summary><span class="setting-help">${escapeHtml(description)}</span></details>`;
}

/** An undefined `agentId` renders a setting that applies to every agent. */
function renderSetting(agentId: string | undefined, setting: SettingView): string {
	const owner = agentId === undefined ? 'data-global="true"' : `data-agent="${escapeHtml(agentId)}"`;
	const attributes = `${owner} data-key="${escapeHtml(setting.key)}" data-type="${setting.type}" title="${escapeHtml(setting.description)}"`;
	const optionsHelp = (setting.options ?? []).map((option, index) => setting.optionDescriptions?.[index] ? `${option}: ${setting.optionDescriptions[index]}` : '').filter(Boolean).join(' ');
	const info = renderInfo(setting.label, [setting.description, optionsHelp].filter(Boolean).join(' '));
	const label = `<span class="setting-label">${escapeHtml(setting.label)}</span>`;

	if (setting.type === 'boolean') {
		const checked = setting.value === true ? ' checked' : '';
		return `<div class="setting setting-checkbox"><label><input type="checkbox" ${attributes}${checked}> ${label}</label>${info}</div>`;
	}

	if (setting.type === 'enum') {
		const options = setting.options ?? [];
		const optionDescriptions = setting.optionDescriptions ?? [];
		const items = options.map((option, index) => {
			const selected = option === setting.value ? ' selected' : '';
			const description = optionDescriptions[index] ? ` title="${escapeHtml(optionDescriptions[index])}"` : '';
			return `<option value="${escapeHtml(option)}"${description}${selected}>${escapeHtml(option)}</option>`;
		}).join('');
		return `<div class="setting"><div class="setting-heading">${label}${info}</div><select aria-label="${escapeHtml(setting.label)}" ${attributes}>${items}</select></div>`;
	}

	if (setting.type === 'number') {
		return `<div class="setting"><div class="setting-heading">${label}${info}</div><input aria-label="${escapeHtml(setting.label)}" type="number" ${attributes} value="${escapeHtml(String(setting.value))}"></div>`;
	}

	const text = Array.isArray(setting.value) ? setting.value.join(', ') : String(setting.value);
	return `<div class="setting"><div class="setting-heading">${label}${info}</div><input aria-label="${escapeHtml(setting.label)}" type="text" ${attributes} value="${escapeHtml(text)}"></div>`;
}

function renderWindow(window: UsageWindow): string {
	const percent = clampPercent(window.usedPercent);
	const resets = window.resets ? `<span class="resets">resets ${escapeHtml(window.resets)}</span>` : '';
	const description = window.label === 'Cumulative cache hit rate'
		? 'The token-weighted cache hit rate across requests since this window opened, including background requests. Subagent and compaction calls are excluded.'
		: window.label === 'Last chat turn cache hit rate'
			? 'The cache hit rate across all model calls in the last completed chat turn.'
			: window.label === 'Last background request cache hit rate'
				? 'The cache hit rate across model calls in the last completed background request.'
				: window.label === 'Last model call cache hit rate'
					? 'The cache hit rate for the most recent individual model call.'
					: 'The percentage of this usage allowance used, as reported by the agent.';
	return `<div class="usage-window">`
		+ `<div class="usage-head"><span>${escapeHtml(window.label)} ${renderInfo(window.label, description)}</span><span>${percent}%</span></div>`
		+ `<div class="bar"><div class="bar-fill" style="width:${percent}%"></div></div>`
		+ resets
		+ `</div>`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

function renderCacheMisses(misses: NonNullable<AgentCardState['usage']['cacheMisses']>): string {
	const idle = misses.expired > 0 ? ` <span class="resets">+${misses.expired} after idle</span>` : '';
	const description = 'Calls of a chat that was already running which lost the prompt cache they should have had, such as after a tool change or a reopened session. Calls after the chat sat idle longer than the cache lives are counted apart. Chats seen for the first time are not counted. The token figure is the input billed at full price instead of read from the cache.';
	return `<div class="usage-window">`
		+ `<div class="usage-head"><span>Cache misses ${renderInfo('Cache misses', description)}</span><span>${misses.unexpected}</span></div>`
		+ `<span class="resets">${escapeHtml(formatTokens(misses.lostTokens))} tokens re-billed</span>${idle}`
		+ `</div>`;
}

function renderUsage(agent: AgentCardState): string {
	const usage = agent.usage;
	const parts: string[] = [];
	if (usage.status === 'unsupported') {
		parts.push('<div class="note">Usage is not supported for this agent.</div>');
	}
	if (usage.plan) {
		parts.push(`<div class="plan">Plan: ${escapeHtml(usage.plan)}</div>`);
	}
	for (const window of usage.windows) {
		parts.push(renderWindow(window));
	}
	if (usage.cacheMisses) {
		parts.push(renderCacheMisses(usage.cacheMisses));
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

	const refresh = usage.status === 'unsupported' ? '' : `<button class="link" data-action="refreshUsage" data-agent="${escapeHtml(agent.id)}">Refresh usage</button>`;
	return `<div class="usage">${parts.join('')}${refresh}</div>`;
}

function renderInstall(agent: AgentCardState): string {
	const id = escapeHtml(agent.id);
	if (agent.install === 'installed') {
		return '<span class="badge">Installed</span>';
	}
	if (agent.install === 'installing') {
		const value = agent.installPercent === undefined ? '' : ` value="${Math.round(agent.installPercent)}" max="100"`;
		return `<span>${escapeHtml(agent.busy ?? 'Installing...')}</span><progress aria-label="Installing agent"${value}></progress>`;
	}
	return `<button data-action="install" data-agent="${id}">Install</button>`;
}

function renderAccount(agent: AgentCardState): string {
	const id = escapeHtml(agent.id);
	const disabled = agent.install !== 'installed' || agent.busy ? ' disabled' : '';
	if (agent.hasSavedKey) {
		return `<button class="secondary" data-action="signOut" data-agent="${id}"${disabled}>Remove API key</button>`;
	}
	if (agent.signedIn === 'yes') {
		return '<span class="badge">Signed in</span>';
	}
	if (agent.signedIn === 'unknown') {
		return `<span>Account status unknown</span><button data-action="signIn" data-agent="${id}"${disabled}>Manage sign-in</button>`;
	}
	return `<button data-action="signIn" data-agent="${id}"${disabled}>Sign in</button>`;
}

function renderSettingsPanel(agent: AgentCardState): string {
	const settings = agent.settings.map(setting => renderSetting(agent.id, setting)).join('');
	const disabled = agent.busy ? ' disabled' : '';
	const uninstall = agent.removable && agent.install === 'installed'
		? `<button class="secondary uninstall" data-action="uninstall" data-agent="${escapeHtml(agent.id)}"${disabled}>Uninstall agent</button>`
		: '';
	return `<div class="settings">${settings}${uninstall}</div>`;
}

function renderCard(agent: AgentCardState, settingsOpen: boolean): string {
	const id = escapeHtml(agent.id);
	const checked = agent.enabled ? ' checked' : '';
	const busy = agent.busy ? `<div class="note">${escapeHtml(agent.busy)}</div>` : '';
	const error = agent.error ? `<div class="error">${escapeHtml(agent.error)}</div>` : '';
	const signInUrl = agent.signInUrl
		? `<div class="note">${escapeHtml(agent.signInUrl.message)}</div>`
			+ `<div class="note">Browser did not open? Paste this URL into any browser:</div>`
			+ `<div class="sign-in-url">${escapeHtml(agent.signInUrl.url)}</div>`
			+ `<div class="actions"><button data-action="copySignInUrl" data-agent="${id}">Copy URL</button>`
			+ `<button class="secondary" data-action="openSignInUrl" data-agent="${id}">Open in browser</button></div>`
		: '';
	const gear = `<button class="icon-button" data-action="toggleSettings" data-agent="${id}" aria-label="Settings for ${escapeHtml(agent.displayName)}" aria-expanded="${settingsOpen}" title="Settings">⚙</button>`;

	return `<section class="card" data-agent="${id}">`
		+ `<div class="card-head"><h2>${escapeHtml(agent.displayName)}</h2>`
		+ `<div class="card-controls"><label class="toggle"><input type="checkbox" data-action="setEnabled" data-agent="${id}"${checked}> Enabled</label>${gear}</div></div>`
		+ `<div class="actions">${renderInstall(agent)}${renderAccount(agent)}</div>`
		+ busy
		+ signInUrl
		+ error
		+ renderUsage(agent)
		+ (settingsOpen ? renderSettingsPanel(agent) : '')
		+ `</section>`;
}

export const GLOBAL_SETTINGS_ID = '*global';

function renderGlobalSettings(settings: SettingView[], open: boolean): string {
	if (settings.length === 0) {
		return '';
	}
	return `<details class="global-settings"${open ? ' open' : ''}><summary>Settings for all agents</summary><div class="settings">${settings.map(setting => renderSetting(undefined, setting)).join('')}</div></details>`;
}

export function renderCards(agents: AgentCardState[], openSettings: ReadonlySet<string> = new Set(), globalSettings: SettingView[] = []): string {
	const cards = agents.filter(agent => agent.visible).map(agent => renderCard(agent, openSettings.has(agent.id))).join('');
	const available = agents.filter(agent => !agent.visible);
	const choices = available.map(agent => `<button class="secondary add-choice" data-action="addAgent" data-agent="${escapeHtml(agent.id)}">${escapeHtml(agent.displayName)}</button>`).join('');
	const addAgent = available.length ? `<details class="add-agent"><summary>+ Add agent</summary>${choices}</details>` : '';
	return renderGlobalSettings(globalSettings, openSettings.has(GLOBAL_SETTINGS_ID)) + cards + addAgent;
}
