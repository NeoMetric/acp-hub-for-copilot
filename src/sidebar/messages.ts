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
}

export interface AgentCardState {
	id: string;
	displayName: string;
	install: InstallView;
	signedIn: SignedInView;
	enabled: boolean;
	settings: SettingView[];
	usage: UsageView;
	/** Text for the operation in progress, such as "Signing in..." */
	busy?: string;
	error?: string;
}

export type ToWebview = { type: 'state'; agents: AgentCardState[] };

export type FromWebview =
	| { type: 'ready' }
	| { type: 'install' | 'signIn' | 'signOut' | 'refreshUsage'; agentId: string }
	| { type: 'setEnabled'; agentId: string; enabled: boolean }
	| { type: 'setSetting'; agentId: string; key: string; value: SettingValue };
