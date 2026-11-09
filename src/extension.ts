/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { scopedLog } from './core/logging';
import { REGISTRY } from './core/registry';
import { migrateSecretsOnce } from './core/secretsMigration';
import { migrateInstallsOnce, migrateState, openSharedStore } from './core/sharedStore';
import { stateStoreOf } from './core/stateStore';
import { recordStoragePath } from './core/storageCleanup';
import { vendorOf } from './core/vendors';
import { agentsRoot, storageRoot } from './engine/store/paths';
import { ServerLink } from './hosts/vscode/serverLink';
import { ServerProvider } from './hosts/vscode/serverProvider';
import { SidebarHost } from './sidebar/host';
import { SidebarRelay } from './sidebar/relay';

/** The port a window uses when the user names none; the server's own default. */
const DEFAULT_PORT = 8791;

/** The link this window owns, so `deactivate` stops the server this window started. */
let link: ServerLink | undefined;

/**
 * The window as a client of the ACP Hub server: it reaches or starts the
 * server, publishes the models of every agent through a provider of its own,
 * and hands the sidebar the server's control surface. The agents, their
 * settings and their sign-in live in the server; nothing here knows which
 * agent is which beyond the registry's ids and display names.
 */
export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('ACP Hub', { log: true });
	const log = scopedLog(output);
	const root = storageRoot();
	const extensionDir = context.extensionUri.fsPath;
	const globalStorageDir = context.globalStorageUri.fsPath;
	// The install root of both gateways: an agent installed here is installed for the server, with its logs and pid registry.
	const agentsDir = agentsRoot(root);
	const settings = vscode.workspace.getConfiguration('acpHub');

	// One store for both gateways, so a chat saved in VS Code resumes in the server, and back.
	const shared = openSharedStore({ root, fallbackRoot: globalStorageDir, log });
	log(`The shared store is in ${shared.root}.`, 'debug');
	const legacyState = stateStoreOf(context.globalState);
	if (legacyState) {
		void migrateState(legacyState, shared.store.state).catch(error => log(`Could not copy the extension's saved state into the shared store: ${messageOf(error)}`, 'warn'));
	}
	// An agent the previous version installed under the extension's own folder moves into the shared root once, so an upgrade does not make it look missing.
	void migrateInstallsOnce({
		sourceRoot: globalStorageDir,
		agentsRoot: agentsDir,
		agentIds: REGISTRY.agents.map(agent => agent.id),
		state: shared.store.state,
		log,
	}).catch(error => log(`Could not move the agent installs into ${agentsDir}: ${messageOf(error)}`, 'warn'));
	// A key the previous version saved in the window's secret storage moves into the shared store once, so the sidebar still offers it.
	void migrateSecretsOnce({
		secrets: context.secrets,
		target: shared.store.secrets,
		agentIds: REGISTRY.agents.map(agent => agent.id),
		state: shared.store.state,
		log,
	}).catch(error => log(`Could not carry the saved API keys into the shared store: ${messageOf(error)}`, 'warn'));
	// The uninstall hook deletes the agents with the extension.
	recordStoragePath(extensionDir, agentsDir);

	const binding = new ServerLink({
		root,
		port: settings.get<number>('server.port') ?? DEFAULT_PORT,
		autoStart: settings.get<boolean>('server.autoStart') ?? true,
		serverScript: path.join(extensionDir, 'dist', 'server.js'),
		extensionDir,
		// The prompts the server composes from, kept where the extension always kept them.
		promptsDir: path.join(path.dirname(path.dirname(globalStorageDir)), 'prompts'),
		log,
	});
	link = binding;
	// A server that cannot be used is named once per change, in the channel the user opens for it.
	binding.onDidChange(state => {
		if (state.kind === 'ready') {
			log(`The ACP Hub server answers on ${state.endpoint.baseUrl}${state.owned ? ' (this window started it)' : ''}.`, 'debug');
		} else {
			log(state.reason, 'warn');
		}
	});

	for (const agent of REGISTRY.agents) {
		const vendor = vendorOf(agent.id);
		const provider = new ServerProvider({
			agentId: agent.id,
			vendor,
			link: binding,
			// The extension's own key in the shared store, so the next window offers these models before the server answers.
			state: shared.store.state,
			log: scopedLog(output, agent.id),
			// A chat whose folders this machine does not have runs in the agents folder, as it always did.
			windowFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? agentsDir,
		});
		context.subscriptions.push(
			vscode.lm.registerLanguageModelChatProvider(vendor, provider),
			provider,
		);
		// The Agents window only lists what the workbench resolved, so the models are asked for once.
		void provider.publishModels();
	}

	const relay = new SidebarRelay({
		link: binding,
		openExternal: async url => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
		copyToClipboard: async text => { await vscode.env.clipboard.writeText(text); },
		confirmUninstall: async displayName => {
			const confirmed = await vscode.window.showWarningMessage(
				`Uninstall ${displayName}?`,
				{ modal: true, detail: 'This deletes the agent and the data the extension keeps for it. Your sign-in, saved API key and settings are kept.' },
				'Uninstall',
			);
			return confirmed === 'Uninstall';
		},
		log,
	});
	const sidebar = new SidebarHost(relay, {
		assetUri: relative => vscode.Uri.joinPath(context.extensionUri, relative),
	});

	context.subscriptions.push(
		output,
		binding,
		relay,
		vscode.window.registerWebviewViewProvider('acpHub.agents', sidebar),
		vscode.commands.registerCommand('acpHub.showLogs', () => output.show()),
		vscode.commands.registerCommand('acpHub.signIn', async () => {
			const picked = await vscode.window.showQuickPick(
				REGISTRY.agents.map(agent => ({ label: agent.displayName, id: agent.id })),
				{ title: 'Sign in to an agent' },
			);
			if (picked) {
				relay.send({ type: 'signIn', agentId: picked.id });
			}
		}),
		vscode.commands.registerCommand('acpHub.install', () => vscode.commands.executeCommand('acpHub.agents.focus')),
		vscode.commands.registerCommand('acpHub.refreshUsage', () => {
			for (const agent of REGISTRY.agents) {
				relay.send({ type: 'refreshUsage', agentId: agent.id });
			}
		}),
	);

	// The server runs whether or not a chat is open, so the sidebar has a state to draw at once.
	void binding.ensure();
}

export async function deactivate(): Promise<void> {
	const owned = link;
	link = undefined;
	await owned?.dispose();
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
