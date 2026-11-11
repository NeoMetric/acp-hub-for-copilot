/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { scopedLog } from './core/logging';
import { resolveNode } from './core/nodeRuntime';
import { REGISTRY } from './core/registry';
import { migrateSecretsOnce } from './core/secretsMigration';
import { migrateSettingsOnce } from './core/settingsMigration';
import { loadConfig } from './hosts/http/config';
import { migrateInstallsOnce, migrateState, openSharedStore } from './core/sharedStore';
import { stateStoreOf } from './core/stateStore';
import { recordStoragePath } from './core/storageCleanup';
import { vendorOf } from './core/vendors';
import { agentsRoot, storageRoot } from './engine/store/paths';
import { ModelNames } from './engine/models/modelNames';
import { copilotProvidersFile } from './hosts/vscode/applyNames';
import { syncModels } from './hosts/vscode/syncModels';
import { ServerLink } from './hosts/vscode/serverLink';
import { ServerProvider } from './hosts/vscode/serverProvider';
import { warmAgents } from './hosts/vscode/warmAgents';
import { changedAgents } from './sidebar/agentChanges';
import { SidebarHost } from './sidebar/host';
import { SidebarRelay } from './sidebar/relay';
import type { ControlState } from './ui/messages';

/** How long a server no window uses stays up, in minutes, when the setting is absent. */
const DEFAULT_IDLE_MINUTES = 30;

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
	// The server's own lines live in a channel of their own, so the window's channel shows only what the window did.
	const serverOutput = vscode.window.createOutputChannel('ACP Hub Server', { log: true });
	const serverLog = scopedLog(serverOutput);
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
	// The previous version read the agents' settings from the user's own settings; the server reads them from config.json, so what the user saved moves there once.
	void migrateSettingsOnce({
		saved: section => settings.inspect(section)?.globalValue,
		config: loadConfig(root, log),
		agents: REGISTRY.agents.map(agent => ({ id: agent.id, settingKeys: [...REGISTRY.commonSettings, ...agent.settings].map(spec => spec.key) })),
		state: shared.store.state,
		log,
	}).catch(error => log(`Could not carry the previous settings into the shared store: ${messageOf(error)}`, 'warn'));
	// The uninstall hook deletes the agents with the extension.
	recordStoragePath(extensionDir, agentsDir);

	const providers = new Map<string, ServerProvider>();

	const binding = new ServerLink({
		root,
		detached: settings.get<boolean>('server.detached') ?? true,
		autoStart: settings.get<boolean>('server.autoStart') ?? true,
		idleMinutes: Math.max(0, settings.get<number>('server.idleTimeoutMinutes') ?? DEFAULT_IDLE_MINUTES),
		version: typeof context.extension.packageJSON?.version === 'string' ? context.extension.packageJSON.version : undefined,
		serverScript: path.join(extensionDir, 'dist', 'server.js'),
		nodeCommand: () => resolveNode({ root, log }),
		extensionDir,
		// The prompts the server composes from, kept where the extension always kept them.
		promptsDir: path.join(path.dirname(path.dirname(globalStorageDir)), 'prompts'),
		log,
		serverLog,
	});
	link = binding;
	// A server that cannot be used is named once per change, in the channel the user opens for it.
	binding.onDidChange(state => {
		if (state.kind === 'ready') {
			log(`The ACP Hub server answers on ${state.endpoint.baseUrl}${state.owned ? ' (this window started it)' : ''}.`, 'debug');
			warmAgents(state.endpoint).then(
				agents => log(`Starting the ${agents.join(', ') || 'no'} agent(s) ahead of the first chat.`),
				error => log(`Could not warm the agents: ${messageOf(error)}`, 'warn'),
			);
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
			// Read-only: the server's saved models, so the window offers them before the server answers.
			state: shared.store.state,
			log: scopedLog(output, agent.id),
			// A chat whose folders this machine does not have runs in the agents folder, as it always did.
			windowFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? agentsDir,
		});
		providers.set(agent.id, provider);
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

	// An agent that was installed, uninstalled, switched on or off, signed in or given a key changes
	// which models the picker may offer, so that agent's provider is asked to list them again.
	let drawn: ControlState | undefined;
	const unsubscribeCards = relay.onState(state => {
		for (const agentId of changedAgents(drawn, state)) {
			providers.get(agentId)?.refresh();
		}
		drawn = state;
	});

	context.subscriptions.push(
		output,
		serverOutput,
		binding,
		relay,
		{ dispose: unsubscribeCards },
		vscode.window.registerWebviewViewProvider('acpHub.agents', sidebar),
		vscode.commands.registerCommand('acpHub.showLogs', () => output.show()),
		vscode.commands.registerCommand('acpHub.showServerLogs', () => serverOutput.show()),
		vscode.commands.registerCommand('acpHub.stopServer', async () => {
			if (await binding.stopServer()) {
				void vscode.window.showInformationMessage('The ACP Hub server and its agents were stopped. They start again when a chat needs them.');
			} else {
				void vscode.window.showWarningMessage('The ACP Hub server could not be stopped. See the ACP Hub log for the reason.');
			}
		}),
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
		vscode.commands.registerCommand('acpHub.syncModels', async () => {
			const state = await binding.ensure({ background: true });
			if (state.kind !== 'ready') {
				void vscode.window.showWarningMessage(`The ACP Hub server is not available (${state.reason}), so the model pickers were not synced.`);
				return;
			}
			try {
				const outcome = await syncModels({
					endpoint: state.endpoint,
					agents: REGISTRY.agents,
					names: new ModelNames(shared.store.state),
					state: shared.store.state,
					packageJson: path.join(extensionDir, 'package.json'),
					providersFile: copilotProvidersFile(),
				});
				for (const problem of outcome.problems) {
					log(problem, 'warn');
				}
				for (const provider of providers.values()) {
					provider.refresh();
				}
				const summary = `Synced ${outcome.models} model(s) of ${outcome.providers} agent(s) into the Copilot model pickers.`;
				const advice = outcome.reloadNeeded
					? 'Reload the window to see the provider names, and restart the Copilot CLI.'
					: 'Restart the Copilot CLI to see them there.';
				// Each target reported its own outcome, so a failure in one still says what the other did.
				const text = [summary, advice, ...outcome.problems].join(' ');
				const reload = 'Reload Window';
				const choices = outcome.reloadNeeded ? [reload] : [];
				const answer = outcome.problems.length > 0
					? await vscode.window.showWarningMessage(text, ...choices)
					: await vscode.window.showInformationMessage(text, ...choices);
				if (answer === reload) {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			} catch (error) {
				void vscode.window.showErrorMessage(`The model pickers were not synced: ${messageOf(error)}`);
			}
		}),
	);

	// The server runs whether or not a chat is open, so the sidebar has a state to draw at once. This is a
	// background start: a window that opens after the user stopped the server attaches to one that answers,
	// but starts none, so opening a window does not undo the stop.
	void binding.ensure({ background: true });
}

export async function deactivate(): Promise<void> {
	const owned = link;
	link = undefined;
	await owned?.dispose();
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
