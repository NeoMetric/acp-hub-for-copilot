/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UsageWindow } from '../core/adapter';

export type SettingValue = string | number | boolean | string[];

export interface SettingView {
	key: string;
	label: string;
	description: string;
	type: 'string' | 'number' | 'boolean' | 'enum' | 'string-list';
	value: SettingValue;
	options?: string[];
	optionDescriptions?: string[];
}

export type InstallView = 'installed' | 'not-installed' | 'installing';
export type SignedInView = 'yes' | 'no' | 'unknown';
export type UsageStatusView = 'unsupported' | 'idle' | 'loading' | 'ok' | 'unavailable' | 'error';

export interface UsageView {
	status: UsageStatusView;
	windows: UsageWindow[];
	plan?: string;
	note?: string;
	error?: string;
	fetchedAt?: number;
	/** Cache misses of chats that were already running. */
	cacheMisses?: { unexpected: number; expired: number; lostTokens: number };
}

export interface AgentCardState {
	id: string;
	displayName: string;
	install: InstallView;
	/** Whether the extension installed the agent and so can uninstall it. */
	removable: boolean;
	signedIn: SignedInView;
	hasSavedKey: boolean;
	/** Present when the agent can sign in with an API key; the page then offers a field for one. */
	apiKey?: { label: string; keyPrefix?: string };
	enabled: boolean;
	visible: boolean;
	settings: SettingView[];
	usage: UsageView;
	/** Text for the operation in progress, such as "Signing in..." */
	busy?: string;
	/** Percent of the install done, when it is known. */
	installPercent?: number;
	/** A page the user has to open to finish signing in, with the agent's instructions for it. */
	signInUrl?: { url: string; message: string };
	error?: string;
}

/** The names the Models page edits: each agent's provider and its models, with the name the agent itself gives them. */
export interface ModelsView {
	agents: Array<{
		agentId: string;
		provider: { name: string; default: string };
		models: Array<{ value: string; name: string; default: string }>;
	}>;
}

/** What the Models page asks of the host; each action resolves to the notice the page shows. */
export interface ModelsSurface {
	view(): Promise<ModelsView>;
	setProviderName(agentId: string, name: string): Promise<string>;
	setModelName(agentId: string, model: string, name: string): Promise<string>;
	/** Reads the agents' models again, and answers what it refreshed. */
	refresh(): Promise<string>;
}

/**
 * One point of the usage chart: a day, a week or an hour, and the four token kinds
 * that point spent. `w` and `a` index the workspaces and agents of the view, and
 * `v` is positional, so a month of history stays small on the wire.
 */
export interface UsagePoint {
	/** `YYYY-MM-DD` for a day or the week's Monday, `HH` for an hour. */
	d: string;
	w: number;
	a: number;
	/** Fresh input, cache read, cache write, output. */
	v: [number, number, number, number];
}

/** The usage history the page draws, in the three grids its ranges need. */
export interface UsageHistoryView {
	retentionDays: number;
	agents: Array<{ id: string; name: string }>;
	workspaces: Array<{ id: string; name: string }>;
	/** At most 30 days of daily points. */
	days: UsagePoint[];
	/** The whole retention window, one point per week. */
	weeks: UsagePoint[];
	/** At most 24 hours of today. */
	today: UsagePoint[];
	/** True when nothing has ever been recorded. */
	empty: boolean;
}

/** What the Usage view asks of the host. Range and filters stay on the page; only retention travels. */
export interface UsageHistorySurface {
	view(): Promise<UsageHistoryView>;
	setRetentionDays(days: number): Promise<void>;
}

/** Everything the page draws, in one snapshot that names no host. */
export interface ControlState {
	agents: AgentCardState[];
	globalSettings?: SettingView[];
	/** Present when the host can rename providers and models. */
	models?: ModelsView;
	/** Present when the host keeps a history of what the turns spent. */
	usage?: UsageHistoryView;
	/** What the last Models action did. */
	notice?: string;
	/** Whether the models are being read from the agents now. */
	refreshing?: boolean;
}

export type ToWebview = { type: 'state' } & ControlState;

export type FromWebview =
	| { type: 'ready' }
	| { type: 'setGlobalSetting'; key: string; value: SettingValue }
	| { type: 'install' | 'uninstall' | 'signIn' | 'signOut' | 'refreshUsage' | 'copySignInUrl' | 'openSignInUrl'; agentId: string }
	| { type: 'addAgent' | 'removeAgent'; agentId: string }
	| { type: 'saveApiKey'; agentId: string; key: string }
	| { type: 'setEnabled'; agentId: string; enabled: boolean }
	| { type: 'setSetting'; agentId: string; key: string; value: SettingValue }
	| { type: 'setProviderName'; agentId: string; name: string }
	| { type: 'setModelName'; agentId: string; model: string; name: string }
	| { type: 'refreshModels' };

/** Everything the page asks a host to do; the same message travels over either transport. */
export type ControlAction = FromWebview;
