/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter } from '../core/adapter';
import { canUninstall } from '../core/installers';
import type { ControlSurface } from '../engine/control/ControlService';
import type { AgentCardState, ControlAction, ControlState, SettingValue, SettingView } from './messages';

/** What the page asks of the host it runs in; neither part touches a window or a DOM. */
export interface ControlPageHost {
	/** Opens a URL in the host's browser. */
	openExternal(url: string): Promise<void>;
	/** Copies text to the host's clipboard. */
	copyToClipboard(text: string): Promise<void>;
}

/** A settings section that applies to every agent, with the value it takes when nothing is stored. */
const GLOBAL_SETTINGS: Array<Omit<SettingView, 'value'> & { default: SettingValue }> = [
	{
		key: 'resume.transcriptDetail',
		label: 'Restored chat detail',
		description: 'How an earlier conversation is restored when a chat has no saved agent session to continue.',
		type: 'enum',
		default: 'compact',
		options: ['compact', 'full'],
		optionDescriptions: [
			'Messages plus the names of the tools that ran. Tool results are left out.',
			'Messages plus tool call arguments and tool results, each cut to the per-result limit. Restores more but costs more tokens.',
		],
	},
	{
		key: 'resume.transcriptMaxCharacters',
		label: 'Restored chat size limit',
		description: 'Upper bound, in characters, for the restored conversation. The oldest messages are dropped first.',
		type: 'number',
		default: 40000,
	},
	{
		key: 'resume.transcriptMaxToolResultCharacters',
		label: 'Restored tool result limit',
		description: 'Upper bound, in characters, for one tool result when the detail is full.',
		type: 'number',
		default: 4000,
	},
];

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One page's worth of state and behaviour over a `ControlSurface`: the actions
 * the page sends, the card each agent deserves, and the snapshots it draws.
 * A sidebar in a window and a tab in a browser drive this same class.
 */
export class ControlPage {
	private readonly installing = new Set<string>();
	private readonly busy = new Map<string, string>();
	/** Percent done of each running install that can tell; others show an endless bar. */
	private readonly installProgress = new Map<string, number>();
	private readonly errors = new Map<string, string>();
	private readonly signInUrls = new Map<string, { url: string; message: string }>();
	private readonly listeners = new Set<(state: ControlState) => void | Promise<void>>();
	private readonly enabledWrites = new Map<string, Promise<void>>();
	private visibleAgents: Set<string> | undefined;
	private stateVersion = 0;

	constructor(private readonly control: ControlSurface, private readonly host: ControlPageHost) {
		control.onUsageChange(agentId => {
			// A read that proves the account makes an earlier sign-in complaint stale.
			if (control.usage(agentId).signedIn === true) {
				this.errors.delete(agentId);
			}
			void this.publish();
		});
		control.onSignInUrl?.((agentId, prompt) => this.showSignInUrl(agentId, prompt));
	}

	/** Registers where the snapshots go; the returned function unregisters. */
	onState(listener: (state: ControlState) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Redraws for a change the host learned of outside the page, such as an expired sign-in. */
	refresh(): void {
		void this.publish();
	}

	/** Shows the page an agent wants the user to open to sign in, opening it too; `undefined` clears it. */
	showSignInUrl(adapterId: string, prompt: { url: string; message: string } | undefined): void {
		if (prompt) {
			this.signInUrls.set(adapterId, prompt);
			void this.host.openExternal(prompt.url);
		} else if (!this.signInUrls.delete(adapterId)) {
			return;
		}
		void this.publish();
	}

	/** Runs one action the page sent. */
	async handle(action: ControlAction): Promise<void> {
		if (action.type === 'ready') {
			await this.publish();
			return;
		}
		if (action.type === 'setGlobalSetting') {
			if (GLOBAL_SETTINGS.some(spec => spec.key === action.key)) {
				await this.control.writeGlobalSetting(action.key, action.value);
				await this.publish();
			}
			return;
		}

		const adapter = this.control.agents().find(item => item.id === action.agentId);
		if (!adapter) {
			return;
		}

		switch (action.type) {
			case 'addAgent':
			case 'removeAgent': {
				await this.ensureVisibleAgents();
				if (action.type === 'addAgent') {
					this.visibleAgents!.add(adapter.id);
				} else {
					this.visibleAgents!.delete(adapter.id);
				}
				await this.control.saveVisibleAgents([...this.visibleAgents!]);
				await this.publish();
				return;
			}
			case 'install':
				await this.install(adapter);
				return;
			case 'uninstall':
				if (!this.installing.has(adapter.id)) {
					await this.runBusy(adapter, 'Uninstalling...', async () => { await this.control.uninstall(adapter.id); });
				}
				return;
			case 'signIn':
				await this.signIn(adapter);
				return;
			case 'signOut':
				await this.runBusy(adapter, 'Signing out...', () => this.control.signOut(adapter.id));
				return;
			case 'refreshUsage':
				await this.control.refreshUsage(adapter.id);
				return;
			case 'setEnabled': {
				const previous = this.enabledWrites.get(adapter.id) ?? Promise.resolve();
				const write = previous.then(() => this.runBusy(adapter, undefined, () => this.control.setEnabled(adapter.id, action.enabled)));
				this.enabledWrites.set(adapter.id, write);
				await write;
				if (this.enabledWrites.get(adapter.id) === write) {
					this.enabledWrites.delete(adapter.id);
				}
				return;
			}
			case 'copySignInUrl':
			case 'openSignInUrl': {
				// The stored URL is used, never one that came from the page.
				const prompt = this.signInUrls.get(adapter.id);
				if (prompt) {
					await (action.type === 'copySignInUrl' ? this.host.copyToClipboard(prompt.url) : this.host.openExternal(prompt.url));
				}
				return;
			}
			case 'setSetting':
				await this.runBusy(adapter, undefined, () => this.control.writeSetting(adapter.id, action.key, action.value));
				return;
		}
	}

	/** The snapshot the page draws now. */
	async state(): Promise<ControlState> {
		await this.ensureVisibleAgents();
		const agents: AgentCardState[] = [];
		for (const adapter of this.control.agents()) {
			agents.push(await this.buildCard(adapter));
		}
		const globalSettings: SettingView[] = GLOBAL_SETTINGS.map(({ default: fallback, ...spec }) => ({
			...spec,
			value: this.control.readGlobalSetting(spec.key) ?? fallback,
		}));
		return { agents, globalSettings };
	}

	/** Hands a fresh snapshot to every listener, unless a newer one already went out. */
	async publish(): Promise<void> {
		if (this.listeners.size === 0) {
			return;
		}
		const version = ++this.stateVersion;
		const state = await this.state();
		if (version !== this.stateVersion) {
			return;
		}
		for (const listener of [...this.listeners]) {
			await listener(state);
		}
	}

	private async install(adapter: AgentAdapter): Promise<void> {
		if (this.installing.has(adapter.id)) {
			return;
		}
		this.installing.add(adapter.id);
		this.errors.delete(adapter.id);
		this.busy.set(adapter.id, 'Installing...');
		await this.publish();
		try {
			await this.control.install(adapter.id, (message, fraction) => {
				this.busy.set(adapter.id, message);
				if (fraction !== undefined) {
					this.installProgress.set(adapter.id, fraction);
				}
				void this.publish();
			});
		} catch (error) {
			this.errors.set(adapter.id, `Install failed: ${errorText(error)}`);
		}
		this.installing.delete(adapter.id);
		this.installProgress.delete(adapter.id);
		this.busy.delete(adapter.id);
		await this.publish();
	}

	private async signIn(adapter: AgentAdapter): Promise<void> {
		await this.runBusy(adapter, 'Signing in...', async () => {
			const result = await this.control.signIn(adapter.id);
			if (!result.ok) {
				throw new Error(result.message ?? 'Sign-in did not complete.');
			}
		});
	}

	/** Runs one operation on a card, showing the busy text and turning a failure into the card's error line. */
	private async runBusy(adapter: AgentAdapter, busyText: string | undefined, operation: () => Promise<void>): Promise<void> {
		this.errors.delete(adapter.id);
		if (busyText) {
			this.busy.set(adapter.id, busyText);
			await this.publish();
		}
		try {
			await operation();
		} catch (error) {
			this.errors.set(adapter.id, errorText(error));
		}
		this.busy.delete(adapter.id);
		await this.publish();
	}

	private async buildCard(adapter: AgentAdapter): Promise<AgentCardState> {
		const installState = await this.control.installState(adapter.id);
		const signedIn = await this.control.isSignedIn(adapter.id);
		const hasSavedKey = await this.control.hasSavedKey(adapter.id);
		const usage = this.control.usage(adapter.id);
		const settings = this.control.readSettings(adapter.id);

		const settingViews: SettingView[] = adapter.settings.map(spec => ({
			key: spec.key,
			label: spec.label,
			description: spec.description,
			type: spec.type,
			value: settings[spec.key] ?? spec.default,
			options: spec.options,
			optionDescriptions: spec.optionDescriptions,
		}));

		return {
			id: adapter.id,
			displayName: adapter.displayName,
			install: this.installing.has(adapter.id) ? 'installing' : installState,
			removable: canUninstall(adapter),
			signedIn: signedIn === undefined ? 'unknown' : signedIn ? 'yes' : 'no',
			hasSavedKey,
			enabled: this.control.isEnabled(adapter.id),
			visible: this.visibleAgents!.has(adapter.id),
			settings: settingViews,
			usage: {
				status: usage.status,
				windows: [...(usage.reading?.windows ?? []), ...usage.extraWindows,
					...(usage.lastModelCall ? [{ label: 'Last model call cache hit rate', usedPercent: usage.lastModelCall.hitRate }] : [])],
				plan: usage.reading?.plan,
				note: usage.reading?.note,
				error: usage.error,
				fetchedAt: usage.fetchedAt,
				cacheMisses: usage.cacheMisses,
			},
			busy: this.busy.get(adapter.id),
			installPercent: this.installProgress.get(adapter.id),
			signInUrl: this.signInUrls.get(adapter.id),
			error: this.errors.get(adapter.id),
		};
	}

	private async ensureVisibleAgents(): Promise<void> {
		if (this.visibleAgents) {
			return;
		}
		const saved = this.control.visibleAgents();
		if (saved) {
			this.visibleAgents = new Set(saved);
			return;
		}
		const installed: string[] = [];
		for (const adapter of this.control.agents()) {
			if (await this.control.installState(adapter.id) === 'installed') {
				installed.push(adapter.id);
			}
		}
		this.visibleAgents ??= new Set(installed);
		await this.control.saveVisibleAgents([...this.visibleAgents]);
	}
}
