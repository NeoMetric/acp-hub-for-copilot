import * as path from 'node:path';
import * as vscode from 'vscode';
import { ADAPTERS, findAdapter } from './core/agents';
import type { AgentAdapter, LaunchContext } from './core/adapter';
import { signIn, terminalMethodsFrom } from './core/auth';
import { pickSignInChoice, runInVsCodeTerminal } from './core/authPrompts';
import { McpBridge } from './core/bridge';
import { findInstalled, installAgent, needsUpdate } from './core/installers';
import { scopedLog } from './core/logging';
import { killAllChildren, killStrayAgents } from './core/processes';
import { AcpProvider } from './core/provider';
import { AgentSecretStore } from './core/secrets';
import { migrateState, openSharedStore } from './core/sharedStore';
import { stateStoreOf } from './core/stateStore';
import { readAgentSettings } from './core/settings';
import { recordStoragePath } from './core/storageCleanup';
import { UsageStore } from './core/usage';
import { ControlService } from './engine/control/ControlService';
import type { ConfigReader } from './engine/ports/state';
import { agentsRoot, storageRoot } from './engine/store/paths';
import { createVsCodeHost } from './hosts/vscode/host';
import { SidebarHost } from './sidebar/host';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('ACP Hub', { log: true });
	const log = scopedLog(output);
	const bridge = new McpBridge(log);
	const extensionStorageDir = context.globalStorageUri.fsPath;
	// One store for both gateways, so a chat saved in VS Code resumes in the server, and back.
	const shared = openSharedStore({ root: storageRoot(), fallbackRoot: extensionStorageDir, log });
	const state = shared.store.state;
	log(`The shared store is in ${shared.root}.`, 'debug');
	// The install root of both gateways: an agent installed here is installed for the server, with its logs and pid registry.
	const storageDir = agentsRoot(shared.root);
	const legacyState = stateStoreOf(context.globalState);
	if (legacyState) {
		void migrateState(legacyState, state).catch(error => log(`Could not copy the extension's saved state into the shared store: ${error instanceof Error ? error.message : String(error)}`, 'warn'));
	}
	const secrets = new AgentSecretStore(context.secrets, shared.store.secrets);
	const usage = new UsageStore(log);
	const providers = new Map<string, AcpProvider>();
	const installEnv = { storageDir, extensionDir: context.extensionUri.fsPath, log, progress: (message: string) => log(message) };
	recordStoragePath(installEnv.extensionDir, storageDir);
	const settings: ConfigReader = { get: <T>(section: string) => vscode.workspace.getConfiguration('acpHub').get<T>(section) };
	// Everything the engine may ask of this host — the extension state, the credentials,
	// the settings and the window's folder — for the providers of every agent.
	const host = createVsCodeHost({
		log,
		state,
		secrets,
		storageRoot: shared.root,
		settings,
		windowFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? storageDir,
		agentName: id => findAdapter(id)?.displayName ?? id,
		signIn: id => { void chooseSignIn(id); },
		showOutput: () => output.show(),
	});
	for (const adapter of ADAPTERS) { killStrayAgents(path.join(storageDir, adapter.id, 'agents')); }

	function adapterFor(id: string): AgentAdapter {
		const adapter = findAdapter(id);
		if (!adapter) { throw new Error(`Unknown agent: ${id}`); }
		return adapter;
	}
	function settingsFor(adapter: AgentAdapter) {
		const result = readAgentSettings(adapter, settings);
		for (const warning of result.warnings) { log(warning, 'warn'); }
		return result.values;
	}
	async function resolveLaunch(adapter: AgentAdapter): Promise<LaunchContext | undefined> {
		const installed = await findInstalled(adapter, { ...installEnv, settings: settingsFor(adapter) });
		if (!installed) { return undefined; }
		return {
			...installed,
			storageDir: path.join(storageDir, adapter.id),
			settings: settingsFor(adapter),
			apiKey: await secrets.get(adapter.id),
			workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? storageDir,
		};
	}
	async function chooseSignIn(id: string): Promise<{ ok: boolean; message?: string }> {
		const adapter = adapterFor(id);
		const choice = await pickSignInChoice(adapter, terminalMethodsFrom(adapter, []));
		if (!choice) { return { ok: false, message: 'Sign-in was cancelled.' }; }
		const launch = await resolveLaunch(adapter);
		if (!launch) { return { ok: false, message: 'Install the agent first.' }; }
		const result = await signIn(adapter, choice, {
			store: secrets, ctx: launch, runTerminal: options => runInVsCodeTerminal(options, storageDir),
			startAgent: methodId => providers.get(id)?.startForSignIn(methodId) ?? Promise.resolve(false),
		});
		if (result.ok) { await state.update(`signedIn.${id}`, true); providers.get(id)?.invalidateLaunch(); await providers.get(id)?.restart(); providers.get(id)?.refresh(); void control.refreshUsage(id); }
		return result;
	}
	// Everything the page does, with the window's own parts — its prompts, its modal, its
	// agents and the folder they work in — handed in as callbacks.
	const control = new ControlService({
		adapters: ADAPTERS,
		state,
		secrets,
		settings,
		usage,
		install: installEnv,
		writeConfig: async (key, value) => { await vscode.workspace.getConfiguration('acpHub').update(key, value, vscode.ConfigurationTarget.Global); },
		host: {
			signIn: chooseSignIn,
			showOutput: () => output.show(),
			launchOf: resolveLaunch,
			confirmUninstall: async adapter => {
				const confirmed = await vscode.window.showWarningMessage(
					`Uninstall ${adapter.displayName}?`,
					{ modal: true, detail: 'This deletes the agent and the data the extension keeps for it. Your sign-in, saved API key and settings are kept.' },
					'Uninstall',
				);
				return confirmed === 'Uninstall';
			},
			closeSessions: async id => { await providers.get(id)?.closeAllSessions(); },
			restartAgent: async id => { await providers.get(id)?.restart(); },
			refreshAgent: id => { providers.get(id)?.invalidateLaunch(); providers.get(id)?.refresh(); },
			publishModels: async id => { await providers.get(id)?.publishModels(); },
			prepareAgent: id => providers.get(id)?.prepareAgent() ?? Promise.resolve(false),
			askAgent: (id, prompt) => providers.get(id)?.askAgent(prompt) ?? Promise.resolve(undefined),
		},
	});
	for (const adapter of ADAPTERS) {
		const provider = new AcpProvider(adapter, {
			log: scopedLog(output, adapter.id), bridge, state, host,
			resolveLaunch: () => resolveLaunch(adapter),
			isEnabled: () => control.isEnabled(adapter.id),
			client: {
				log: scopedLog(output, adapter.id),
				storageDir: path.join(storageDir, adapter.id),
				clientVersion: String(context.extension.packageJSON.version),
				onSignInUrl: prompt => sidebar.showSignInUrl(adapter.id, prompt),
			},
			requestDumpDir: context.globalStorageUri,
			profilePromptsDir: path.join(path.dirname(path.dirname(extensionStorageDir)), 'prompts'),
			signIn: id => { void chooseSignIn(id); },
			showOutput: () => output.show(),
		});
		providers.set(adapter.id, provider);
		context.subscriptions.push(
			provider,
			provider.onDidRequireSignIn(() => {
				void state.update(`signedIn.${adapter.id}`, false);
				sidebar.refresh();
			}),
			provider.onDidMeasureRequest(measurement => usage.recordRequest(adapter.id, measurement)),
			provider.onDidFinishTurn(turn => {
				usage.recordTurn(adapter.id, adapter.reportsCache === false ? undefined : turn.usage, turn.background);
				if (!turn.background && adapter.usage && !adapter.usage.onDemandOnly) { void control.refreshUsage(adapter.id, false); }
			}),
			vscode.lm.registerLanguageModelChatProvider(adapter.vendor, provider),
		);
		void provider.publishModels();
	}
	// A usage read is the best proof of the account: limits came back, or the agent asked for credentials.
	context.subscriptions.push({
		dispose: usage.onDidChange(id => {
			const signedIn = usage.get(id).signedIn;
			if (signedIn !== undefined && state.get<boolean>(`signedIn.${id}`) !== signedIn) {
				void state.update(`signedIn.${id}`, signedIn);
			}
		}),
	});
	const sidebar = new SidebarHost(control, {
		openExternal: async url => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
		copyToClipboard: async text => { await vscode.env.clipboard.writeText(text); },
		assetUri: relative => vscode.Uri.joinPath(context.extensionUri, relative),
	});
	context.subscriptions.push(
		output, bridge, secrets,
		vscode.window.registerWebviewViewProvider('acpHub.agents', sidebar),
		vscode.commands.registerCommand('acpHub.showLogs', () => output.show()),
		vscode.commands.registerCommand('acpHub.signIn', async () => {
			const picked = await vscode.window.showQuickPick(ADAPTERS.map(adapter => ({ label: adapter.displayName, id: adapter.id })));
			if (picked) { await chooseSignIn(picked.id); }
		}),
		vscode.commands.registerCommand('acpHub.install', () => vscode.commands.executeCommand('acpHub.agents.focus')),
		vscode.commands.registerCommand('acpHub.refreshUsage', async () => { for (const adapter of ADAPTERS) { await control.refreshUsage(adapter.id); } }),
		vscode.workspace.onDidChangeConfiguration(event => {
			for (const adapter of ADAPTERS) {
				if (event.affectsConfiguration(`acpHub.agents.${adapter.id}`)) {
					providers.get(adapter.id)?.invalidateLaunch();
					void providers.get(adapter.id)?.restart();
					providers.get(adapter.id)?.refresh();
				}
			}
		}),
		secrets.onDidChange(id => {
			providers.get(id)?.invalidateLaunch();
			void providers.get(id)?.restart();
			providers.get(id)?.refresh();
		}),
		// The user is back: an agent the idle shutdown stopped starts while they type, not after they send.
		vscode.window.onDidChangeWindowState(state => {
			if (state.focused && state.active) { for (const provider of providers.values()) { provider.wakeAfterIdle(); } }
		}),
	);
	// An agent downloaded by version stays usable at the older one until the newer one is in place.
	async function updateOutdated(adapter: AgentAdapter): Promise<void> {
		const env = { ...installEnv, settings: settingsFor(adapter) };
		if (!await needsUpdate(adapter, env)) { return; }
		log(`${adapter.displayName} has an update; installing it while the installed version stays in use.`);
		let shown = 0;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating ${adapter.displayName}` }, async progress => {
			await installAgent(adapter, installEnv, update => {
				if (update.state !== 'progress') { return; }
				const fraction = update.fraction ?? shown;
				progress.report({ message: update.message, increment: Math.max(0, fraction - shown) });
				shown = Math.max(shown, fraction);
			});
		});
		providers.get(adapter.id)?.invalidateLaunch();
		providers.get(adapter.id)?.refresh();
	}
	for (const adapter of ADAPTERS) {
		if (adapter.usage && !adapter.usage.onDemandOnly && control.isEnabled(adapter.id)) {
			void control.refreshUsage(adapter.id, false).catch(error => log(`Could not start usage refresh for ${adapter.id}: ${String(error)}`, 'warn'));
		}
		void updateOutdated(adapter).catch(error => log(`Could not update ${adapter.displayName}: ${error instanceof Error ? error.message : String(error)}`, 'warn'));
	}
}

export function deactivate(): void { killAllChildren(); }
