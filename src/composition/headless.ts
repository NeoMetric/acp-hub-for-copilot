/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { AgentAdapter, AgentSettings, LaunchContext } from '../core/adapter';
import { ADAPTERS } from '../core/agents';
import { signIn } from '../core/auth';
import { findInstalled } from '../core/installers';
import { readAgentSettings, settingKey } from '../core/settings';
import { createSessionPrompt, type PromptWorkspace } from '../core/systemPrompt';
import { ChatService } from '../engine/chat/ChatService';
import { readTranscriptOptions, type TranscriptOptions } from '../engine/chat/messages';
import type { ToolBridge } from '../engine/chat/types';
import { UsageStore } from '../engine/chat/usage';
import { ControlService, type ControlSurface } from '../engine/control/ControlService';
import type { HostPort, Log } from '../engine/ports/host';
import { agentsRoot } from '../engine/store/paths';
import { defaultWorkspaceOf } from '../hosts/http/config';
import { createHeadlessHost, stderrLog, type HeadlessHost } from '../hosts/http/host';

/** What the headless gateway needs to exist. */
export interface HeadlessCompositionOptions {
	/** The store root: `config.json`, `state.json`, `secrets.json` and `agents/<id>` live here. */
	readonly root: string;
	/**
	 * The loopback MCP bridge the request's tools reach the HTTP client through.
	 * The engine's `McpBridge` is host-neutral, so a headless host passes one of
	 * those; the server may supply its own.
	 */
	readonly bridge: ToolBridge;
	/** Where the host tells what it does; the server's stderr by default. */
	readonly log?: Log;
	/** Where the adapters' npm manifests are; the working directory by default. */
	readonly extensionDir?: string;
	/** The client whose chats these are: the token's principal, or `default` when there is none. */
	readonly owner?: string;
	/**
	 * The folder holding the user's own prompt files, which every chat is offered.
	 * A server has no VS Code profile, so this is the only place its user-level
	 * customization files come from.
	 */
	readonly promptsDir?: string;
	/** The agents this gateway serves: the registry by default, and the one under test in a test. */
	readonly adapters?: readonly AgentAdapter[];
}

/** One host, the adapters it can drive, and the chat use case of each. */
export interface HeadlessComposition {
	readonly host: HostPort;
	readonly adapters: readonly AgentAdapter[];
	/** The service of one agent, by the id the registry gives it. */
	serviceOf(agentId: string): ChatService | undefined;
	/** Stops every agent and releases the sessions of every chat. */
	close(): Promise<void>;
}

/** The headless gateway's composition, with the control page's operations over the same agents and store. */
export interface HeadlessGateways extends HeadlessComposition {
	/** The host the gateway runs in, which also writes the settings the control page changes. */
	readonly host: HeadlessHost;
	readonly control: ControlSurface;
	/** The cache and usage figures the page shows, as the chat services record them. */
	readonly usage: UsageStore;
	/** The transcript settings the services read, from the host's `config.json`. */
	transcriptOptions(): TranscriptOptions;
	/** The context windows an agent reported for its models, which the model list serves. */
	reportedWindowsOf(agentId: string): ReadonlyMap<string, number>;
}

/** The engine wired for a process with no window: the same agents and chats the extension serves. */
export function createHeadlessComposition(options: HeadlessCompositionOptions): HeadlessGateways {
	const root = path.resolve(options.root);
	const log = options.log ?? stderrLog;
	const extensionDir = options.extensionDir ?? process.cwd();
	const adapters = options.adapters ?? ADAPTERS;
	const host = createHeadlessHost({ root, log, owner: options.owner });
	const agentsDir = agentsRoot(root);
	/** Where the agents are installed, and where an install reports what it does. */
	const install = {
		storageDir: agentsDir,
		extensionDir,
		log,
		progress: (message: string) => log(message),
	};
	const usage = new UsageStore(log);
	/** The context windows each agent reported, which narrow the windows its models are served with. */
	const reportedWindows = new Map<string, Map<string, number>>();
	const windowsOf = (agentId: string): Map<string, number> => {
		let windows = reportedWindows.get(agentId);
		if (!windows) {
			windows = new Map();
			reportedWindows.set(agentId, windows);
		}
		return windows;
	};
	const transcriptOptions = (): TranscriptOptions => readTranscriptOptions(host.settings);
	/**
	 * The folders a chat may draw customization files from. A server has no window
	 * and no trust prompt: the folder the operator configured is the one it serves.
	 */
	const workspaceOf = (): PromptWorkspace => {
		const folder = defaultWorkspaceOf(host.settings);
		return { trusted: true, windowFolders: folder ? [folder] : [] };
	};

	const settingsOf = (adapter: AgentAdapter): AgentSettings => {
		const result = readAgentSettings(adapter, host.settings);
		for (const warning of result.warnings) {
			log(`${adapter.id}: ${warning}`, 'warn');
		}
		return result.values;
	};

	/** The folder of the window the extension would have; a request that names another folder is rooted in it instead. */
	const workspaceFolder = (): string => defaultWorkspaceOf(host.settings) ?? process.cwd();

	const resolveLaunch = async (adapter: AgentAdapter): Promise<LaunchContext | undefined> => {
		const settings = settingsOf(adapter);
		const installed = await findInstalled(adapter, {
			...install,
			settings,
		});
		if (!installed) {
			return undefined;
		}
		return {
			...installed,
			storageDir: path.join(agentsDir, adapter.id),
			settings,
			apiKey: await host.secrets.get(adapter.id),
			workspaceFolder: workspaceFolder(),
		};
	};

	const services = new Map<string, ChatService>();
	for (const adapter of adapters) {
		// What the extension's provider hands its chat service, mirrored over this host:
		// the customization prompt, the transcript settings, the cache and usage figures
		// the page shows, and an expired sign-in. The request dump is the one loss, until
		// the server has a setting naming the folder it writes to (Task 4).
		services.set(adapter.id, new ChatService({
			adapter,
			host,
			bridge: options.bridge,
			resolveLaunch: () => resolveLaunch(adapter),
			isEnabled: () => host.settings.get<boolean>(settingKey(adapter.id, 'enabled')) !== false,
			client: { onSignInUrl: prompt => control.reportSignInUrl(adapter.id, prompt) },
			buildSessionPrompt: createSessionPrompt(log, adapter.systemPrompt, workspaceOf, options.promptsDir),
			transcriptOptions,
			refineWindow: (model, size) => { windowsOf(adapter.id).set(model, size); },
			finished: turn => {
				usage.recordTurn(adapter.id, adapter.reportsCache === false ? undefined : turn.usage, turn.background);
				if (!turn.background && adapter.usage && !adapter.usage.onDemandOnly) {
					void control.refreshUsage(adapter.id, false);
				}
			},
			measured: measurement => usage.recordRequest(adapter.id, measurement),
			signInRequired: () => {
				void host.state.update(`signedIn.${adapter.id}`, false);
				// The page draws the sign-in state from the usage it watches, so it is told to read it again.
				void control.refreshUsage(adapter.id, false);
			},
			agentChanged: change => {
				if (change === 'restarted') {
					// A restarted agent may be another account or version; the windows it reported are no longer known.
					reportedWindows.delete(adapter.id);
				}
			},
		}));
	}

	// The same operations the sidebar drives, over this host's store, agents and
	// settings, so the browser page installs, signs in and configures as the
	// extension does.
	const control = new ControlService({
		adapters,
		state: host.state,
		secrets: host.secrets,
		settings: host.settings,
		usage,
		install,
		writeConfig: async (key, value) => {
			await host.writeSetting(key, value);
			// A setting decides how the agents launch, so the launch read is forgotten.
			for (const service of services.values()) {
				service.invalidateLaunch();
			}
		},
		host: {
			signIn: async agentId => {
				const adapter = adapters.find(item => item.id === agentId);
				const service = services.get(agentId);
				const launch = adapter ? await resolveLaunch(adapter) : undefined;
				if (!adapter || !service || !launch) {
					return { ok: false, message: 'Install the agent first.' };
				}
				// A browser flow runs inside the agent: the page shows the URL it asks for and this waits for the result.
				const browser = adapter.auth.find(method => method.kind === 'oauth-browser' && !method.terminalCommand);
				if (browser) {
					return signIn(adapter, { kind: 'browser', method: browser }, {
						store: host.secrets,
						ctx: launch,
						runTerminal: async () => { },
						startAgent: methodId => service.startForSignIn(methodId),
					});
				}
				// A server has no terminal to open, so the page hands over the command to run in one.
				const terminal = adapter.auth.find(method => method.kind === 'oauth-browser' && method.terminalCommand);
				if (terminal?.kind === 'oauth-browser' && terminal.terminalCommand) {
					const command = ['node', `"${launch.entryPath}"`, ...terminal.terminalCommand].join(' ');
					return { ok: false, message: `This server has no terminal to sign in with. Run this in one, then choose Refresh usage: ${command}` };
				}
				return { ok: false, message: `${adapter.displayName} signs in with an API key; save one on this page.` };
			},
			launchOf: adapter => resolveLaunch(adapter),
			confirmUninstall: async () => true,
			closeSessions: async agentId => { await services.get(agentId)?.closeAllSessions(); },
			restartAgent: async agentId => { await services.get(agentId)?.restart(); },
			refreshAgent: agentId => { services.get(agentId)?.invalidateLaunch(); },
			prepareAgent: async agentId => {
				const service = services.get(agentId);
				if (!service) {
					return false;
				}
				try {
					await service.client();
					return true;
				} catch {
					return false;
				}
			},
			askAgent: (agentId, prompt) => services.get(agentId)?.askAgent(prompt) ?? Promise.resolve(undefined),
		},
	});

	return {
		host,
		adapters,
		serviceOf: agentId => services.get(agentId),
		control,
		usage,
		transcriptOptions,
		reportedWindowsOf: agentId => windowsOf(agentId),
		close: async () => {
			await Promise.all([...services.values()].map(service => service.close()));
		},
	};
}
