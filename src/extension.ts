import * as path from 'node:path';
import * as vscode from 'vscode';
import { ADAPTERS, findAdapter } from './core/agents';
import type { AgentAdapter, LaunchContext } from './core/adapter';
import { signIn, signOut, terminalMethodsFrom } from './core/auth';
import { pickSignInChoice, runInVsCodeTerminal } from './core/authPrompts';
import { McpBridge } from './core/bridge';
import { findInstalled, getInstallState, installAgent, uninstallAgent } from './core/installers';
import { scopedLog } from './core/logging';
import { killAllChildren, killStrayAgents } from './core/processes';
import { AcpProvider } from './core/provider';
import { AgentSecretStore } from './core/secrets';
import { readAgentSettings, settingKey } from './core/settings';
import { recordStoragePath } from './core/storageCleanup';
import { UsageStore } from './core/usage';
import { SidebarHost } from './sidebar/host';
import type { SettingValue } from './sidebar/messages';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('ACP Hub', { log: true });
	const log = scopedLog(output);
	const bridge = new McpBridge(log);
	const secrets = new AgentSecretStore(context.secrets);
	const usage = new UsageStore(log);
	const providers = new Map<string, AcpProvider>();
	const storageDir = context.globalStorageUri.fsPath;
	const installEnv = { storageDir, extensionDir: context.extensionUri.fsPath, log, progress: (message: string) => log(message) };
	recordStoragePath(installEnv.extensionDir, storageDir);
	for (const adapter of ADAPTERS) { killStrayAgents(path.join(storageDir, adapter.id, 'agents')); }

	function adapterFor(id: string): AgentAdapter {
		const adapter = findAdapter(id);
		if (!adapter) { throw new Error(`Unknown agent: ${id}`); }
		return adapter;
	}
	function settingsFor(adapter: AgentAdapter) {
		const result = readAgentSettings(adapter, vscode.workspace.getConfiguration('acpHub'));
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
			store: secrets, ctx: launch, runTerminal: runInVsCodeTerminal,
			startAgent: methodId => providers.get(id)?.startForSignIn(methodId) ?? Promise.resolve(false),
		});
		if (result.ok) { await context.globalState.update(`signedIn.${id}`, true); await providers.get(id)?.restart(); providers.get(id)?.refresh(); }
		return result;
	}
	async function refreshUsage(id: string, force = true): Promise<void> {
		const adapter = adapterFor(id);
		const launch = await resolveLaunch(adapter);
		if (!launch) { return; }
		await usage.refresh(adapter, { launch, ready: () => providers.get(id)?.prepareAgent() ?? Promise.resolve(false), askAgent: prompt => providers.get(id)?.askAgent(prompt) ?? Promise.resolve(undefined) }, force);
	}
	for (const adapter of ADAPTERS) {
		const provider = new AcpProvider(adapter, {
			log: scopedLog(output, adapter.id), bridge, state: context.globalState,
			resolveLaunch: () => resolveLaunch(adapter),
			isEnabled: () => vscode.workspace.getConfiguration('acpHub').get<boolean>(settingKey(adapter.id, 'enabled'), true),
			client: {
				log: scopedLog(output, adapter.id),
				storageDir: path.join(storageDir, adapter.id),
				clientVersion: String(context.extension.packageJSON.version),

			},
			requestDumpDir: context.globalStorageUri,
			profilePromptsDir: path.join(path.dirname(path.dirname(storageDir)), 'prompts'),
			signIn: id => { void chooseSignIn(id); },
			showOutput: () => output.show(),
		});
		providers.set(adapter.id, provider);
		context.subscriptions.push(
			provider,
			provider.onDidRequireSignIn(() => {
				void context.globalState.update(`signedIn.${adapter.id}`, false);
				sidebar.refresh();
			}),
			provider.onDidMeasureRequest(measurement => usage.recordRequest(adapter.id, measurement)),
			provider.onDidFinishTurn(turn => {
				usage.recordTurn(adapter.id, turn.usage, turn.background);
				if (!turn.background && adapter.usage) { void refreshUsage(adapter.id, false); }
			}),
			vscode.lm.registerLanguageModelChatProvider(adapter.vendor, provider),
		);
		void provider.publishModels();
	}
	// A usage read is the best proof of the account: limits came back, or the agent asked for credentials.
	context.subscriptions.push({
		dispose: usage.onDidChange(id => {
			const signedIn = usage.get(id).signedIn;
			if (signedIn !== undefined && context.globalState.get<boolean>(`signedIn.${id}`) !== signedIn) {
				void context.globalState.update(`signedIn.${id}`, signedIn);
			}
		}),
	});
	const sidebar = new SidebarHost({
		listAdapters: () => ADAPTERS,
		getVisibleAgents: () => context.globalState.get<string[]>('sidebar.visibleAgents'),
		saveVisibleAgents: async ids => { await context.globalState.update('sidebar.visibleAgents', ids); },
		getInstallState: id => getInstallState(adapterFor(id), { ...installEnv, settings: settingsFor(adapterFor(id)) }),
		install: async (id, onProgress) => { await installAgent(adapterFor(id), installEnv, update => { if (update.state === 'progress') { onProgress(update.message); } }); providers.get(id)?.refresh(); await providers.get(id)?.publishModels(); },
		uninstall: async id => {
			const adapter = adapterFor(id);
			const confirmed = await vscode.window.showWarningMessage(
				`Uninstall ${adapter.displayName}?`,
				{ modal: true, detail: 'This deletes the agent and the data the extension keeps for it. Your sign-in, saved API key and settings are kept.' },
				'Uninstall',
			);
			if (confirmed !== 'Uninstall') { return false; }
			const provider = providers.get(id);
			await provider?.closeAllSessions();
			await provider?.restart();
			await uninstallAgent(adapter, installEnv);
			provider?.refresh();
			await provider?.publishModels();
			return true;
		},
		isSignedIn: async id => {
			if (await secrets.get(id)) { return true; }
			return context.globalState.get<boolean>(`signedIn.${id}`);
		},
		hasSavedKey: async id => Boolean(await secrets.get(id)),
		signIn: chooseSignIn,
		signOut: async id => { await signOut(id, secrets); await providers.get(id)?.restart(); providers.get(id)?.refresh(); },
		readSettings: id => settingsFor(adapterFor(id)),
		writeSetting: async (id, key, value) => { await vscode.workspace.getConfiguration('acpHub').update(settingKey(id, key), value, vscode.ConfigurationTarget.Global); },
		readGlobalSetting: key => vscode.workspace.getConfiguration('acpHub').get<SettingValue>(key),
		writeGlobalSetting: async (key, value) => { await vscode.workspace.getConfiguration('acpHub').update(key, value, vscode.ConfigurationTarget.Global); },
		isEnabled: id => vscode.workspace.getConfiguration('acpHub').get<boolean>(settingKey(id, 'enabled'), true),
		setEnabled: async (id, enabled) => { await vscode.workspace.getConfiguration('acpHub').update(settingKey(id, 'enabled'), enabled, vscode.ConfigurationTarget.Global); providers.get(id)?.refresh(); },
		getUsage: id => adapterFor(id).usage ? usage.get(id) : { ...usage.get(id), status: 'unsupported' },
		refreshUsage,
		onUsageChange: listener => ({ dispose: usage.onDidChange(listener) }),
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
		vscode.commands.registerCommand('acpHub.refreshUsage', async () => { for (const adapter of ADAPTERS) { await refreshUsage(adapter.id); } }),
		vscode.workspace.onDidChangeConfiguration(event => {
			for (const adapter of ADAPTERS) {
				if (event.affectsConfiguration(`acpHub.agents.${adapter.id}`)) { void providers.get(adapter.id)?.restart(); providers.get(adapter.id)?.refresh(); }
			}
		}),
		secrets.onDidChange(id => { void providers.get(id)?.restart(); providers.get(id)?.refresh(); }),
	);
	for (const adapter of ADAPTERS) {
		if (adapter.usage && vscode.workspace.getConfiguration('acpHub').get<boolean>(settingKey(adapter.id, 'enabled'), true)) {
			void refreshUsage(adapter.id, false).catch(error => log(`Could not start usage refresh for ${adapter.id}: ${String(error)}`, 'warn'));
		}
	}
}

export function deactivate(): void { killAllChildren(); }
