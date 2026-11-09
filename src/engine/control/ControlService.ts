/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter, AgentSettings, LaunchContext } from '../../core/adapter';
import { signOut as clearCredentials } from '../../core/auth';
import { getInstallState, installAgent, uninstallAgent, type InstallEnvironment, type InstallState } from '../../core/installers';
import { readAgentSettings, settingKey } from '../../core/settings';
import type { UsageState, UsageStore } from '../chat/usage';
import type { ConfigReader, SecretStore, StateStore } from '../ports/state';

/** A value a setting holds; the same kinds the agent adapters declare. */
export type SettingValue = string | number | boolean | string[];

/** What signing an agent in produced. */
export interface SignInOutcome {
	ok: boolean;
	message?: string;
}

/** Where an install reports how far it got; the fraction is absent while it is unknown. */
export type InstallProgress = (message: string, fraction?: number) => void;

/**
 * What the service asks of the host it runs in: the parts that need the host's
 * own window, its own agents, or the way it launches them. Everything else — the
 * store, the settings, the installs, the usage — the service does itself, which
 * is what lets a second host drive the same page.
 */
export interface ControlHost {
	/** Signs the agent in through the host's own flow: its prompts, its terminal or its browser. */
	signIn(agentId: string): Promise<SignInOutcome>;
	/** Shows the host's own output; a host that keeps none for the page leaves it out. */
	showOutput?(): void;
	/** What launching the agent takes, or `undefined` when it is not installed. */
	launchOf(adapter: AgentAdapter): Promise<LaunchContext | undefined>;
	/** Asks the user to confirm an uninstall; a host whose page already asked answers true. */
	confirmUninstall?(adapter: AgentAdapter): Promise<boolean>;
	/** Stops the chats the agent is running, so its files can be replaced. */
	closeSessions?(agentId: string): Promise<void>;
	/** Restarts the agent, so it runs the files and the credentials that are there now. */
	restartAgent?(agentId: string): Promise<void>;
	/** Reloads the agent's models after an install or a setting change. */
	refreshAgent?(agentId: string): void;
	/** Republishes the agent's model list, where the host has one to publish. */
	publishModels?(agentId: string): Promise<void>;
	/** Starts the agent so its usage can be read; resolves `false` when it cannot start. */
	prepareAgent?(agentId: string): Promise<boolean>;
	/** Sends a prompt to the running agent, for a usage source that reads the account that way. */
	askAgent?(agentId: string, prompt: string): Promise<string | undefined>;
}

/** Every operation the page performs, as one surface both hosts can offer. */
export interface ControlSurface {
	agents(): readonly AgentAdapter[];
	visibleAgents(): string[] | undefined;
	saveVisibleAgents(agentIds: string[]): Promise<void>;
	installState(agentId: string): Promise<InstallState>;
	/** Rejects when the install fails. */
	install(agentId: string, onProgress: InstallProgress): Promise<void>;
	/** Resolves to false when the user declines to uninstall. */
	uninstall(agentId: string): Promise<boolean>;
	isSignedIn(agentId: string): Promise<boolean | undefined>;
	hasSavedKey(agentId: string): Promise<boolean>;
	signIn(agentId: string): Promise<SignInOutcome>;
	signOut(agentId: string): Promise<void>;
	readSettings(agentId: string): AgentSettings;
	writeSetting(agentId: string, key: string, value: SettingValue): Promise<void>;
	/** Reads a setting under `acpHub.` that applies to every agent, such as `resume.transcriptDetail`. */
	readGlobalSetting(key: string): SettingValue | undefined;
	writeGlobalSetting(key: string, value: SettingValue): Promise<void>;
	isEnabled(agentId: string): boolean;
	setEnabled(agentId: string, enabled: boolean): Promise<void>;
	usage(agentId: string): UsageState;
	refreshUsage(agentId: string, force?: boolean): Promise<void>;
	/**
	 * Tells the page to draw an agent again after a change it could not observe
	 * itself, such as a sign-in that expired mid-turn.
	 */
	refresh(agentId: string): void;
	onUsageChange(listener: (agentId: string) => void): { dispose(): void };
	/** Tells a listener the page an agent asks the user to open to sign in; `undefined` clears it. */
	onSignInUrl?(listener: (agentId: string, prompt: SignInUrlPrompt | undefined) => void): { dispose(): void };
}

export interface SignInUrlPrompt {
	url: string;
	message: string;
}

/** What the service reads and writes, and what it asks the host to do. */
export interface ControlServiceOptions {
	/** The agents this host can drive. */
	readonly adapters: readonly AgentAdapter[];
	/** The store both gateways share. */
	readonly state: StateStore;
	/** The credentials both gateways share. */
	readonly secrets: SecretStore;
	/** The host's configuration, where the settings live. */
	readonly settings: ConfigReader;
	readonly usage: UsageStore;
	/** Where the agents are installed, and where the installs report what they do. */
	readonly install: InstallEnvironment;
	/** Writes one setting of the host's configuration; `key` is the name without the `acpHub.` prefix. */
	writeConfig(key: string, value: SettingValue): Promise<void>;
	readonly host: ControlHost;
}

/**
 * The page's operations, with no host in them: a sidebar in a window and a page
 * in a browser drive the same installs, settings, credentials and usage.
 */
export class ControlService implements ControlSurface {
	private readonly signInUrlListeners = new Set<(agentId: string, prompt: SignInUrlPrompt | undefined) => void>();
	/** What the page draws from: a usage read, and a change of an agent the host learns of on its own. */
	private readonly changeListeners = new Set<(agentId: string) => void>();

	constructor(private readonly options: ControlServiceOptions) {
		// A usage read is the best proof of the account: limits came back, or the agent asked for credentials.
		options.usage.onDidChange(agentId => {
			const signedIn = options.usage.get(agentId).signedIn;
			if (signedIn !== undefined && options.state.get<boolean>(`signedIn.${agentId}`) !== signedIn) {
				void options.state.update(`signedIn.${agentId}`, signedIn);
			}
			this.changed(agentId);
		});
	}

	agents(): readonly AgentAdapter[] {
		return this.options.adapters;
	}

	visibleAgents(): string[] | undefined {
		return this.options.state.get<string[]>('sidebar.visibleAgents');
	}

	async saveVisibleAgents(agentIds: string[]): Promise<void> {
		await this.options.state.update('sidebar.visibleAgents', agentIds);
	}

	async installState(agentId: string): Promise<InstallState> {
		const adapter = this.adapter(agentId);
		return getInstallState(adapter, this.installEnvironment(adapter));
	}

	async install(agentId: string, onProgress: InstallProgress): Promise<void> {
		const adapter = this.adapter(agentId);
		await installAgent(adapter, this.options.install, update => {
			if (update.state === 'progress') { onProgress(update.message, update.fraction); }
		});
		onProgress('Starting the agent...');
		this.options.host.refreshAgent?.(agentId);
		await this.options.host.publishModels?.(agentId);
	}

	async uninstall(agentId: string): Promise<boolean> {
		const adapter = this.adapter(agentId);
		if (this.options.host.confirmUninstall && !await this.options.host.confirmUninstall(adapter)) {
			return false;
		}
		await this.options.host.closeSessions?.(agentId);
		await this.options.host.restartAgent?.(agentId);
		await uninstallAgent(adapter, this.options.install);
		this.options.host.refreshAgent?.(agentId);
		await this.options.host.publishModels?.(agentId);
		return true;
	}

	async isSignedIn(agentId: string): Promise<boolean | undefined> {
		if (await this.options.secrets.get(agentId)) { return true; }
		return this.options.state.get<boolean>(`signedIn.${agentId}`);
	}

	async hasSavedKey(agentId: string): Promise<boolean> {
		return Boolean(await this.options.secrets.get(agentId));
	}

	async signIn(agentId: string): Promise<SignInOutcome> {
		const outcome = await this.options.host.signIn(agentId);
		if (outcome.ok) {
			await this.options.state.update(`signedIn.${agentId}`, true);
			void this.refreshUsage(agentId);
		}
		return outcome;
	}

	/** Passes on the page an agent asks the user to open to sign in. */
	reportSignInUrl(agentId: string, prompt: SignInUrlPrompt | undefined): void {
		for (const listener of [...this.signInUrlListeners]) {
			listener(agentId, prompt);
		}
	}

	onSignInUrl(listener: (agentId: string, prompt: SignInUrlPrompt | undefined) => void): { dispose(): void } {
		this.signInUrlListeners.add(listener);
		return { dispose: () => { this.signInUrlListeners.delete(listener); } };
	}

	async signOut(agentId: string): Promise<void> {
		await clearCredentials(agentId, this.options.secrets);
		await this.options.host.restartAgent?.(agentId);
		this.options.host.refreshAgent?.(agentId);
	}

	readSettings(agentId: string): AgentSettings {
		const result = readAgentSettings(this.adapter(agentId), this.options.settings);
		for (const warning of result.warnings) { this.options.install.log(warning, 'warn'); }
		return result.values;
	}

	async writeSetting(agentId: string, key: string, value: SettingValue): Promise<void> {
		await this.options.writeConfig(settingKey(agentId, key), value);
	}

	readGlobalSetting(key: string): SettingValue | undefined {
		return this.options.settings.get<SettingValue>(key);
	}

	async writeGlobalSetting(key: string, value: SettingValue): Promise<void> {
		await this.options.writeConfig(key, value);
	}

	isEnabled(agentId: string): boolean {
		return this.options.settings.get<boolean>(settingKey(agentId, 'enabled')) ?? true;
	}

	async setEnabled(agentId: string, enabled: boolean): Promise<void> {
		await this.options.writeConfig(settingKey(agentId, 'enabled'), enabled);
		this.options.host.refreshAgent?.(agentId);
	}

	usage(agentId: string): UsageState {
		const adapter = this.adapter(agentId);
		const state = this.options.usage.get(agentId);
		return adapter.usage ? state : { ...state, status: 'unsupported' };
	}

	async refreshUsage(agentId: string, force = true): Promise<void> {
		const adapter = this.adapter(agentId);
		const launch = await this.options.host.launchOf(adapter);
		if (!launch) { return; }
		await this.options.usage.refresh(adapter, {
			launch,
			ready: () => this.options.host.prepareAgent?.(agentId) ?? Promise.resolve(false),
			askAgent: prompt => this.options.host.askAgent?.(agentId, prompt) ?? Promise.resolve(undefined),
		}, force);
	}

	onUsageChange(listener: (agentId: string) => void): { dispose(): void } {
		this.changeListeners.add(listener);
		return { dispose: () => { this.changeListeners.delete(listener); } };
	}

	refresh(agentId: string): void {
		this.changed(agentId);
	}

	private changed(agentId: string): void {
		for (const listener of [...this.changeListeners]) {
			listener(agentId);
		}
	}

	private adapter(agentId: string): AgentAdapter {
		const adapter = this.options.adapters.find(item => item.id === agentId);
		if (!adapter) { throw new Error(`Unknown agent: ${agentId}`); }
		return adapter;
	}

	/** The install environment with the agent's own settings, which its install may read. */
	private installEnvironment(adapter: AgentAdapter): InstallEnvironment {
		return { ...this.options.install, settings: this.readSettings(adapter.id) };
	}
}
