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

export type ToWebview = { type: 'state'; agents: AgentCardState[]; globalSettings?: SettingView[] };

export type FromWebview =
	| { type: 'ready' }
	| { type: 'setGlobalSetting'; key: string; value: SettingValue }
	| { type: 'install' | 'uninstall' | 'signIn' | 'signOut' | 'refreshUsage' | 'copySignInUrl' | 'openSignInUrl'; agentId: string }
	| { type: 'addAgent' | 'removeAgent'; agentId: string }
	| { type: 'setEnabled'; agentId: string; enabled: boolean }
	| { type: 'setSetting'; agentId: string; key: string; value: SettingValue };
