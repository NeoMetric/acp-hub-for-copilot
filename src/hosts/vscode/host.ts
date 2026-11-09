/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { stateStoreOf } from '../../core/stateStore';
import { stripIdentity } from '../../core/identityPatterns';
import type { ChatRequest } from '../../engine/model/chat';
import type { ChatIdentity, HostPort, Log } from '../../engine/ports/host';
import type { ConfigReader, SecretStore } from '../../engine/ports/state';
import { chatIdOf, chatLabelOf, chatWideContextOf, stripHostSections, systemGuidanceOf, workspaceFoldersOf } from './identity';

/**
 * What the workbench sent with one request. The engine's {@link ChatRequest}
 * keeps the words of every message but neither the shape of a Copilot message
 * nor the model options, which are the two things a chat is identified by, so
 * the provider records the original alongside the request it built.
 */
export interface SentRequest {
	readonly messages: readonly vscode.LanguageModelChatRequestMessage[];
	readonly options: vscode.ProvideLanguageModelChatResponseOptions;
}

const SENT = new WeakMap<ChatRequest, SentRequest>();

/** Records what the workbench sent, so the host can read the prompt it wrote when the engine asks. */
export function rememberSent(request: ChatRequest, sent: SentRequest): void {
	SENT.set(request, sent);
}

/** What the workbench sent for `request`, or `undefined` for a request another host built. */
export function sentOf(request: ChatRequest): SentRequest | undefined {
	return SENT.get(request);
}

/** Everything the extension already has, and the only window the host has on it. */
export interface VsCodeHostDeps {
	readonly log: Log;
	/** Extension state; absent for a provider built without one, which then keeps nothing. */
	readonly state: vscode.Memento | undefined;
	/** The agent credentials; a host built without them hands back none. */
	readonly secrets?: SecretStore;
	/** The settings of the agents, as the `acpHub` configuration holds them. */
	readonly settings?: ConfigReader;
	/** The folder the agents are installed in and keep their state in. */
	readonly storageRoot: string;
	/** The folder of the window's first workspace; a chat that names none this machine has is rooted there. */
	windowFolder(): string;
	/** The name of an agent as the user sees it, for the messages the host shows. */
	agentName?(agentId: string): string;
	/** Opens the sidebar's sign-in flow for an agent. */
	signIn(agentId: string): void;
	/** Shows the output channel, where the agent's own log is readable. */
	showOutput(): void;
}

/**
 * VS Code as the engine's host. Copilot tells a provider nothing about the chat
 * it rendered, so every identifier, folder and piece of guidance here is read
 * back out of the prompt the workbench wrote — see {@link file://./identity.ts}.
 */
export function createVsCodeHost(deps: VsCodeHostDeps): HostPort {
	return {
		log: deps.log,
		state: stateStoreOf(deps.state) ?? emptyState,
		secrets: deps.secrets ?? emptySecrets,
		settings: deps.settings ?? { get: <T>(section: string) => vscode.workspace.getConfiguration('acpHub').get<T>(section) },
		storageRoot: deps.storageRoot,
		chatIdentity: request => identityOf(request, deps),
		guidanceOf: request => guidanceOf(request),
		stripHostSections,
		chatWideContextOf,
		// The workbench owns the tools of a request: the provider hands the agent's
		// calls to `McpBridge`, and `ChatService.executeTool` returns the workbench's
		// results. The port has no part in that path here, so it fails loudly rather
		// than pretend to run a call the engine would have dropped.
		executeTool: () => {
			throw new Error('executeTool is not used by this host: VS Code runs tool calls through the workbench bridge.');
		},
		ui: {
			requestSignIn: agentId => requestSignIn(deps, agentId),
			notify: async (message, actions) => vscode.window.showInformationMessage(message, ...(actions ?? [])),
			openExternal: async url => {
				await vscode.env.openExternal(vscode.Uri.parse(url));
			},
		},
	};
}

function identityOf(request: ChatRequest, deps: VsCodeHostDeps): ChatIdentity {
	const sent = sentOf(request);
	const folders = sent ? workspaceFoldersOf(sent.messages) : undefined;
	return {
		id: sent ? chatIdOf(sent.messages, sent.options) : request.chatId,
		// The engine names the folder of the chat when the machine has it; a chat
		// that names none is rooted in the window's folder, where the agent runs.
		cwd: request.cwd || deps.windowFolder(),
		workspaceFolders: folders ?? [],
		label: sent ? chatLabelOf(sent.messages) : undefined,
	};
}

/**
 * The guidance the workbench wrote into the request, without the personality of
 * Copilot. The words are scraped back out of the system message of the request,
 * since that is where this host writes them; a request another host built
 * carries its own, and is stripped here so both reach the agent alike.
 */
function guidanceOf(request: ChatRequest): string | undefined {
	const sent = sentOf(request);
	const guidance = sent ? systemGuidanceOf(sent.messages) : request.systemGuidance;
	if (guidance === undefined) {
		return undefined;
	}
	const stripped = stripIdentity(guidance).trim();
	return stripped.length > 0 ? stripped : undefined;
}

/** Asks the user to sign in, since an agent without credentials serves no request. */
function requestSignIn(deps: VsCodeHostDeps, agentId: string): void {
	const name = deps.agentName?.(agentId) ?? agentId;
	void vscode.window.showWarningMessage(
		`${name} needs credentials: sign in or use an API key.`,
		'Sign In',
		'Show Output',
	).then(choice => {
		if (choice === 'Sign In') {
			deps.signIn(agentId);
		} else if (choice === 'Show Output') {
			deps.showOutput();
		}
	});
}

/** An empty store for a provider started without extension state. */
const emptyState = {
	get: <T>(_key: string): T | undefined => undefined,
	update: (_key: string, _value: unknown): Promise<void> => Promise.resolve(),
	keys: (): readonly string[] => [],
};

/** The engine never reads a secret over this port yet, so a host built without a store hands back none. */
const emptySecrets = {
	get: (_id: string): Promise<string | undefined> => Promise.resolve(undefined),
	set: (_id: string, _value: string): Promise<void> => Promise.resolve(),
	delete: (_id: string): Promise<void> => Promise.resolve(),
};
