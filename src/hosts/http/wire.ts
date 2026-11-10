/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The shapes the HTTP server and its clients agree on. Both the extension and
 * the server bundle this file, so it holds types and constants alone: no Node
 * or VS Code import may appear here.
 */

/** The name a client checks before it trusts a `/health` answer. */
export const SERVER_NAME = 'acp-hub';

/**
 * The version of this contract. A server that does not name a version is older
 * than this one and cannot be talked to.
 */
export const API_VERSION = 1;

/** `POST /shutdown`: asks a server that was given a way to stop to close, agents and all. */
export const SHUTDOWN_ROUTE = '/shutdown';

/** `POST /v1/warm` with `{ "folder": "<path>" }`: starts every enabled agent in that folder ahead of its first chat. */
export const WARM_ROUTE = '/v1/warm';

/** `GET /health`: who the server is, and what it can drive right now. */
export interface HealthWire {
	status: 'ok';
	name: typeof SERVER_NAME;
	version: string;
	apiVersion: number;
	openSessions: number;
	agents: Array<{ id: string; installed: boolean; openSessions: number }>;
}

/** One reasoning effort a model offers, as the picker shows it. */
export interface EffortWire {
	value: string;
	label: string;
	description: string;
}

/** Everything the picker needs about one model, beside its wire id. */
export interface ModelInfoWire {
	name: string;
	family: string;
	version: string;
	detail?: string;
	tooltip?: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	imageInput: boolean;
	efforts: EffortWire[];
	defaultEffort?: string;
	effortTitle?: string;
	effortDescription?: string;
}

/** One entry of `GET /v1/models`, as a stock OpenAI client reads it. */
export interface ModelWire {
	id: string;
	object: 'model';
	owned_by: string;
	acp?: ModelInfoWire;
}

/** The request context the extension sends in the `acp` field of a chat body. */
export interface AcpRequestExtras {
	/**
	 * The id the engine keys this chat's agent session on. It rests on the chat's
	 * whole opening, so a chat and each of its sub-agents — which share a
	 * conversation but open differently — get sessions of their own.
	 */
	sessionKey?: string;
	/** The id of the chat for per-chat figures; the sub-agents of one chat share it. */
	chatId?: string;
	label?: string;
	cwd?: string;
	workspaceFolders?: string[];
	systemGuidance?: string;
	chatContext?: string;
}
