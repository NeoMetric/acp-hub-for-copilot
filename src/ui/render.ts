/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UsageWindow } from '../core/adapter';
import { formatTokens } from './chart';
import { escapeHtml } from './html';
import type { AgentCardState, ModelsView, SettingView, UsageHistoryView, UsagePoint } from './messages';
import { renderAreaChart, renderChartLegend } from './chart';

export { escapeHtml };


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
	const keyButton = agent.apiKey
		? `<button class="secondary" data-action="showApiKey" data-agent="${id}"${disabled}>${agent.hasSavedKey ? 'Replace API key' : 'Use API key'}</button>`
		: '';
	if (agent.hasSavedKey) {
		return `<span class="badge">API key saved</span>${keyButton}<button class="secondary" data-action="signOut" data-agent="${id}"${disabled}>Remove API key</button>`;
	}
	if (agent.signedIn === 'yes') {
		return `<span class="badge">Signed in</span>${keyButton}`;
	}
	if (agent.signedIn === 'unknown') {
		return `<span>Account status unknown</span><button data-action="signIn" data-agent="${id}"${disabled}>Manage sign-in</button>${keyButton}`;
	}
	return `<button data-action="signIn" data-agent="${id}"${disabled}>Sign in</button>${keyButton}`;
}

/** The field an API key is typed into; the page keeps what was typed across redraws. */
function renderKeyEntry(agent: AgentCardState): string {
	if (!agent.apiKey) {
		return '';
	}
	const id = escapeHtml(agent.id);
	const label = escapeHtml(agent.apiKey.label);
	const placeholder = agent.apiKey.keyPrefix ? ` placeholder="${escapeHtml(agent.apiKey.keyPrefix)}..."` : '';
	return `<div class="key-entry"><input type="password" aria-label="${label}" data-key-input="true" data-agent="${id}" autocomplete="off" spellcheck="false"${placeholder}>`
		+ `<div class="actions"><button data-action="saveApiKey" data-agent="${id}">Save</button><button class="secondary" data-action="cancelApiKey" data-agent="${id}">Cancel</button></div></div>`;
}

function renderSettingsPanel(agent: AgentCardState): string {
	const settings = agent.settings.map(setting => renderSetting(agent.id, setting)).join('');
	const disabled = agent.busy ? ' disabled' : '';
	const uninstall = agent.removable && agent.install === 'installed'
		? `<button class="secondary uninstall" data-action="uninstall" data-agent="${escapeHtml(agent.id)}"${disabled}>Uninstall agent</button>`
		: '';
	return `<div class="settings">${settings}${uninstall}</div>`;
}

function renderCard(agent: AgentCardState, settingsOpen: boolean, keyOpen: boolean): string {
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
		+ (keyOpen ? renderKeyEntry(agent) : '')
		+ busy
		+ signInUrl
		+ error
		+ renderUsage(agent)
		+ (settingsOpen ? renderSettingsPanel(agent) : '')
		+ `</section>`;
}

/** The views of the page; a tab is drawn only for the ones the host can fill. */
export type PageView = 'agents' | 'models' | 'usage';

/** Which views this page can show: renaming models needs a Models surface, the chart a usage history. */
export interface PageViews {
	readonly models: boolean;
	readonly usage: boolean;
}

export function renderNav(view: PageView, available: PageViews = { models: true, usage: false }): string {
	const actions: Record<PageView, string> = { agents: 'showAgents', models: 'showModels', usage: 'showUsage' };
	const tab = (target: PageView, label: string): string =>
		`<button class="${view === target ? '' : 'secondary'}" data-action="${actions[target]}" aria-pressed="${view === target}">${label}</button>`;
	const tabs = [
		tab('agents', 'Agents'),
		...(available.models ? [tab('models', 'Models')] : []),
		...(available.usage ? [tab('usage', 'Usage')] : []),
	];
	return `<nav class="page-nav">${tabs.join('')}</nav>`;
}

/** The range of the chart, and the agents and workspaces it leaves in; an empty set means every one. */
export type UsageRange = 'today' | '7' | '30' | 'all';

export interface UsageSelection {
	readonly range: UsageRange;
	readonly agents: ReadonlySet<string>;
	readonly workspaces: ReadonlySet<string>;
}

const USAGE_RANGES: ReadonlyArray<{ readonly value: UsageRange; readonly label: string; readonly days: number }> = [
	{ value: 'today', label: 'Today', days: 1 },
	{ value: '7', label: '7 days', days: 7 },
	{ value: '30', label: '30 days', days: 30 },
	{ value: 'all', label: 'All', days: 0 },
];

/**
 * The points of the last `days` days. The list holds one point per day, workspace
 * and agent, so a slice by count would cut a range short; the days themselves decide.
 */
function withinDays(points: readonly UsagePoint[], days: number): UsagePoint[] {
	const dates = [...new Set(points.map(point => point.d))].sort();
	const kept = new Set(dates.slice(-Math.max(1, days)));
	return points.filter(point => kept.has(point.d));
}

/**
 * The Usage view: what the turns spent over time, in the four token kinds, with
 * the agents and workspaces left in by hand, and the retention that decides how
 * much history there is at all.
 */
export function renderUsageView(view: UsageHistoryView, selection: UsageSelection): string {
	const retention = `<div class="setting usage-retention"><div class="setting-heading">`
		+ `<span class="setting-label">Keep history for</span>${renderInfo('Keep history for', 'How many days of token usage the server keeps. Lowering it deletes the older days for good.')}</div>`
		+ `<div class="actions"><input aria-label="Keep history for" type="number" data-retention="true" min="1" max="365" value="${view.retentionDays}">`
		+ `<button data-action="setRetentionDays">Save</button></div></div>`;

	if (view.empty) {
		return `<div class="usage-view">${retention}`
			+ '<div class="note">Recording starts now; usage before this update was never stored.</div></div>';
	}

	const ranges = USAGE_RANGES.filter(range => range.value !== 'all' || view.retentionDays > 30)
		.map(range => `<button class="${selection.range === range.value ? '' : 'secondary'}" data-action="setUsageRange" data-range="${range.value}" aria-pressed="${selection.range === range.value}">${range.label}</button>`)
		.join('');

	const chosen = (id: string, set: ReadonlySet<string>): boolean => set.size === 0 || set.has(id);
	// A selection can outlive the workspace or agent it names, by a fold, a prune or a day leaving the window.
	// One that no longer exists stops restricting the chart, rather than emptying it with no box left to clear.
	const pick = (ids: readonly string[], selected: ReadonlySet<string>): ReadonlySet<string> => {
		const known = new Set(ids);
		return new Set([...selected].filter(id => known.has(id)));
	};
	const selectedAgents = pick(view.agents.map(agent => agent.id), selection.agents);
	const selectedWorkspaces = pick(view.workspaces.map(workspace => workspace.id), selection.workspaces);
	const box = (attributes: string, label: string, checked: boolean): string =>
		`<label class="usage-filter"><input type="checkbox" ${attributes}${checked ? ' checked' : ''}> ${escapeHtml(label)}</label>`;

	const agents = view.agents
		.map(agent => box(`data-agent-filter="${escapeHtml(agent.id)}"`, agent.name, selectedAgents.has(agent.id)))
		.join('');
	const workspaces = view.workspaces
		.map(workspace => box(`data-workspace-filter="${escapeHtml(workspace.id)}"`, workspace.name, selectedWorkspaces.has(workspace.id)))
		.join('');

	const chosenAgent = (point: { a: number }): string => view.agents[point.a]?.id ?? '';
	const chosenWorkspace = (point: { w: number }): string => view.workspaces[point.w]?.id ?? '';

	const range = USAGE_RANGES.find(item => item.value === selection.range) ?? USAGE_RANGES[2]!;
	const source = selection.range === 'today' ? view.today
		: selection.range === 'all' ? view.weeks
			: withinDays(view.days, range.days);

	const sums = new Map<string, { label: string; values: [number, number, number, number] }>();
	for (const point of source) {
		if (!chosen(chosenAgent(point), selectedAgents) || !chosen(chosenWorkspace(point), selectedWorkspaces)) {
			continue;
		}
		const sum = sums.get(point.d);
		sums.set(point.d, {
			label: point.d,
			values: sum
				? [sum.values[0] + point.v[0], sum.values[1] + point.v[1], sum.values[2] + point.v[2], sum.values[3] + point.v[3]]
				: [...point.v],
		});
	}
	const points = [...sums.values()].sort((a, b) => a.label.localeCompare(b.label));

	const totals: [number, number, number, number] = [0, 0, 0, 0];
	for (const point of points) {
		for (let index = 0; index < 4; index += 1) {
			totals[index] += point.values[index]!;
		}
	}

	return `<div class="usage-view">`
		+ retention
		+ `<div class="actions">${ranges}</div>`
		+ `<div class="usage-filters"><div class="usage-filter-group"><span class="setting-label">Agents</span>${agents}</div>`
		+ `<div class="usage-filter-group"><span class="setting-label">Workspaces</span>${workspaces}</div></div>`
		+ renderAreaChart(points)
		+ renderChartLegend(totals)
		+ '</div>';
}

/** A name as the input being edited: it holds a value only when a name was chosen, and shows the agent's own as its placeholder. */
function nameInput(label: string, attributes: string, name: string, fallback: string): string {
	const value = name === fallback ? '' : name;
	return `<input type="text" aria-label="${escapeHtml(label)}" ${attributes} value="${escapeHtml(value)}" placeholder="${escapeHtml(fallback)}">`;
}

/** A name as text, with the agent's own name beside it when the user chose another. */
function nameText(name: string, fallback: string): string {
	const original = name === fallback ? '' : ` <span class="muted">${escapeHtml(fallback)}</span>`;
	return `<span class="name-value">${escapeHtml(name)}</span>${original}`;
}

/**
 * The Models view: the provider name of each agent, in bold with one pencil that opens the
 * provider name and every model name under it for editing together, and the refresh button.
 * `editing` is the id of the agent whose names are inputs.
 */
export function renderModels(models: ModelsView, notice?: string, options: { refreshing?: boolean; editing?: string } = {}): string {
	const { refreshing = false, editing } = options;
	const status = refreshing
		? '<div class="note fetching" role="status"><progress aria-label="Fetching models"></progress> Fetching models from the agents…</div>'
		: notice ? `<div class="note" role="status">${escapeHtml(notice).replace(/\n/g, '<br>')}</div>` : '';
	const sections = models.agents.map(agent => {
		const id = escapeHtml(agent.agentId);
		const open = editing === agent.agentId;
		const empty = agent.models.length === 0 ? '<div class="note">No models yet; press Refresh to load them.</div>' : '';
		const rows = agent.models.map(model => `<div class="setting">${open
			? nameInput(`name of ${model.default}`, `data-models="model" data-agent="${id}" data-model="${escapeHtml(model.value)}"`, model.name, model.default)
			: nameText(model.name, model.default)}</div>`).join('');
		const head = open
			? `<div class="card-head">${nameInput('provider name', `data-models="provider" data-agent="${id}"`, agent.provider.name, agent.provider.default)}`
				+ `<div class="card-controls"><button data-action="saveNames" data-agent="${id}">Save</button><button class="secondary" data-action="cancelNames" data-agent="${id}">Cancel</button></div></div>`
			: `<div class="card-head"><h2>${nameText(agent.provider.name, agent.provider.default)}</h2>`
				+ `<button class="icon-button" data-action="editNames" data-agent="${id}" aria-label="Rename ${escapeHtml(agent.provider.name)} and its models" title="Rename">✎</button></div>`;
		return `<section class="card" data-agent="${id}">${head}${rows}${empty}</section>`;
	}).join('');
	return `<div class="note">Names shown in the model pickers. Use the pencil to rename a provider and its models; clearing a name restores the agent's own.</div>`
		+ status
		+ sections
		+ `<div class="actions"><button data-action="refreshModels"${refreshing ? ' disabled' : ''}>Refresh</button></div>`;
}
export const GLOBAL_SETTINGS_ID = '*global';

function renderGlobalSettings(settings: SettingView[], open: boolean): string {
	if (settings.length === 0) {
		return '';
	}
	return `<details class="global-settings"${open ? ' open' : ''}><summary>Settings for all agents</summary><div class="settings">${settings.map(setting => renderSetting(undefined, setting)).join('')}</div></details>`;
}

export function renderCards(agents: AgentCardState[], openSettings: ReadonlySet<string> = new Set(), globalSettings: SettingView[] = [], keyEntry: ReadonlySet<string> = new Set()): string {
	const cards = agents.filter(agent => agent.visible).map(agent => renderCard(agent, openSettings.has(agent.id), keyEntry.has(agent.id))).join('');
	const available = agents.filter(agent => !agent.visible);
	const choices = available.map(agent => `<button class="secondary add-choice" data-action="addAgent" data-agent="${escapeHtml(agent.id)}">${escapeHtml(agent.displayName)}</button>`).join('');
	const addAgent = available.length ? `<details class="add-agent"><summary>+ Add agent</summary>${choices}</details>` : '';
	return renderGlobalSettings(globalSettings, openSettings.has(GLOBAL_SETTINGS_ID)) + cards + addAgent;
}
