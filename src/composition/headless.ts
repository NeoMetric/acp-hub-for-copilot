/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentAdapter, AgentSettings, LaunchContext } from '../core/adapter';
import { accountAdapter, accountsSupported, isServing, readAccounts } from '../core/accounts';
import { ADAPTERS } from '../core/agents';
import { signIn } from '../core/auth';
import { startCliLogin, type CliLogin } from '../core/cliLogin';
import { findInstalled } from '../core/installers';
import { readAgentSettings } from '../core/settings';
import { createSessionPrompt, type PromptWorkspace } from '../core/systemPrompt';
import { ChatService } from '../engine/chat/ChatService';
import { readTranscriptOptions, type TranscriptOptions } from '../engine/chat/messages';
import type { ToolBridge } from '../engine/chat/types';
import { UsageStore } from '../engine/chat/usage';
import { DEFAULT_RETAIN_DAYS, UsageLedger } from '../engine/usage/ledger';
import type { UsageHistorySurface } from '../ui/messages';
import { createUsageHistorySurface } from '../hosts/http/usageSurface';
import type { ChatRequest } from '../engine/model/chat';
import { ControlService, type ControlSurface } from '../engine/control/ControlService';
import { withScope } from '../core/logging';
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
	/** The platform the extra accounts are checked against; this process's by default. */
	readonly platform?: NodeJS.Platform;
}

/** One host, the adapters it can drive, and the chat use case of each. */
export interface HeadlessComposition {
	readonly host: HostPort;
	readonly adapters: readonly AgentAdapter[];
	/** The service of one agent, by the id the registry gives it. */
	serviceOf(agentId: string): ChatService | undefined;
	/** The context windows an agent reported for its models, which the model list serves; a host that tracks none omits it. */
	reportedWindowsOf?(agentId: string): ReadonlyMap<string, number>;
	/** The usage history the page charts; a composition without one simply offers no Usage view. */
	readonly usageHistory?: UsageHistorySurface;
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
	/** The token usage of finished turns, kept day by day. */
	readonly ledger: UsageLedger;
	/** The usage history the page charts. */
	readonly usageHistory: UsageHistorySurface;
	/** The transcript settings the services read, from the host's `config.json`. */
	transcriptOptions(): TranscriptOptions;
	/** The context windows an agent reported for its models, which the model list serves. */
	reportedWindowsOf(agentId: string): ReadonlyMap<string, number>;
	/** Serves one more account: builds its chat service and adds it to {@link adapters}. */
	addAccountAdapter(adapter: AgentAdapter): void;
	/** Stops serving an account: closes its chat service and drops it from {@link adapters}. */
	removeAccountAdapter(accountId: string): Promise<void>;
}

/** Writes the request as a JSON file in `folder` when the agent's `dumpRequests` setting is on; a failure is logged, never thrown. */
export function dumpRequest(folder: string, request: ChatRequest, settings: AgentSettings | undefined, log: Log): void {
	if (settings?.dumpRequests !== true) {
		return;
	}
	try {
		fs.mkdirSync(folder, { recursive: true });
		const file = path.join(folder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${request.chatId.replace(/[^\w-]/g, '_').slice(0, 40)}.json`);
		fs.writeFileSync(file, JSON.stringify(request, undefined, 2), 'utf8');
		log(`Request written to ${file}`, 'debug');
	} catch (error) {
		log(`Could not write the request dump: ${error instanceof Error ? error.message : String(error)}`, 'warn');
	}
}

/** The engine wired for a process with no window: the same agents and chats the extension serves. */
export function createHeadlessComposition(options: HeadlessCompositionOptions): HeadlessGateways {
	const root = path.resolve(options.root);
	const log = options.log ?? stderrLog;
	const extensionDir = options.extensionDir ?? process.cwd();
	const platform = options.platform ?? process.platform;
	// One array, changed in place, so everything holding it sees accounts come and go.
	const adapters: AgentAdapter[] = [...(options.adapters ?? ADAPTERS)];
	const host = createHeadlessHost({ root, log, owner: options.owner });
	for (const base of [...adapters]) {
		const warn = (message: string): void => withScope(log, base.id)(message, 'warn');
		if (accountsSupported(base, platform)) {
			adapters.push(...readAccounts(host.settings, base.id, warn).map(record => accountAdapter(base, record)));
		} else if (!base.accountName && readAccounts(host.settings, base.id).length > 0) {
			warn('Extra accounts are only available on Windows; the stored accounts are ignored.');
		}
	}
	const agentsDir = agentsRoot(root);
	/** Where the agents are installed, and where an install reports what it does. */
	const install = {
		storageDir: agentsDir,
		extensionDir,
		log,
		progress: (message: string) => log(message),
	};
	const usage = new UsageStore(log);
	/** The token usage of finished turns, which the page charts; recorded in memory and flushed a couple of seconds later. */
	const ledger = new UsageLedger({
		root,
		retainDays: host.settings.get<number>('usage.retentionDays') ?? DEFAULT_RETAIN_DAYS,
		log,
	});
	const usageHistory = createUsageHistorySurface({
		ledger,
		agents: () => adapters.map(adapter => ({ id: adapter.id, displayName: adapter.displayName })),
		writeRetention: days => host.writeSetting('usage.retentionDays', days),
	});
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
			withScope(log, adapter.id)(warning, 'warn');
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
	const addService = (adapter: AgentAdapter): void => {
		// What the extension's provider hands its chat service, mirrored over this host:
		// the customization prompt, the transcript settings, the cache and usage figures
		// the page shows, an expired sign-in and the request dump.
		services.set(adapter.id, new ChatService({
			adapter,
			host,
			bridge: options.bridge,
			resolveLaunch: () => resolveLaunch(adapter),
			isEnabled: () => isServing(adapter, host.settings),
			client: { onSignInUrl: prompt => control.reportSignInUrl(adapter.id, prompt) },
			buildSessionPrompt: createSessionPrompt(log, adapter.systemPrompt, workspaceOf, options.promptsDir),
			transcriptOptions,
			dumpRequest: (request, settings) => dumpRequest(path.join(agentsDir, adapter.id, 'requests'), request, settings, withScope(log, adapter.id)),
			refineWindow: (model, size) => { windowsOf(adapter.id).set(model, size); },
			finished: turn => {
				usage.recordTurn(adapter.id, adapter.reportsCache === false ? undefined : turn.usage, turn.background);
				ledger.record({ at: Date.now(), agent: adapter.id, workspace: turn.chat?.workspace, usage: turn.usage });
				if (!turn.background && adapter.usage && !adapter.usage.onDemandOnly) {
					void control.refreshUsage(adapter.id, false).catch(error => {
						withScope(log, adapter.id)(`Could not read the usage: ${error instanceof Error ? error.message : String(error)}`, 'warn');
					});
				}
			},
			measured: measurement => usage.recordRequest(adapter.id, measurement),
			signInRequired: () => {
				// The page draws the sign-in state from the store, so it is redrawn once the store says signed out.
				void host.state.update(`signedIn.${adapter.id}`, false)
					.then(() => control.refresh(adapter.id))
					.catch(error => {
						withScope(log, adapter.id)(`Could not record the expired sign-in: ${error instanceof Error ? error.message : String(error)}`, 'warn');
					});
			},
			agentChanged: change => {
				if (change === 'restarted') {
					// A restarted agent may be another account or version; the windows it reported are no longer known.
					reportedWindows.delete(adapter.id);
				}
			},
		}));
	};
	for (const adapter of adapters) {
		addService(adapter);
	}

	const addAccountAdapter = (adapter: AgentAdapter): void => {
		if (services.has(adapter.id)) {
			return;
		}
		addService(adapter);
		adapters.push(adapter);
	};
	const removeAccountAdapter = async (accountId: string): Promise<void> => {
		const index = adapters.findIndex(adapter => adapter.id === accountId);
		const service = services.get(accountId);
		if (index >= 0) {
			adapters.splice(index, 1);
		}
		services.delete(accountId);
		reportedWindows.delete(accountId);
		await service?.close();
	};

	/** The login programs waiting for a pasted code, by agent. */
	const logins = new Map<string, CliLogin>();

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
		platform,
		writeConfig: async (key, value) => {
			await host.writeSetting(key, value);
			// A setting decides how the agents launch, so the launch read is forgotten.
			for (const service of services.values()) {
				service.invalidateLaunch();
			}
		},
		host: {
			submitSignInCode: (agentId, code) => logins.get(agentId)?.submitCode(code) ?? false,
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
				const terminal = adapter.auth.find(method => method.kind === 'oauth-browser' && method.terminalCommand);
				if (terminal?.kind === 'oauth-browser' && terminal.terminalCommand) {
					const accountEnv = adapter.accountName && adapter.accounts ? adapter.accounts.environment(launch.storageDir) : {};
					// A server has no terminal to open, so it runs the login program itself: the page shows the
					// address the program prints and hands back the code that address ends in.
					logins.get(adapter.id)?.cancel();
					const startedAt = Date.now();
					const login = startCliLogin({
						command: process.execPath,
						args: [launch.entryPath, ...terminal.terminalCommand],
						env: { ELECTRON_RUN_AS_NODE: '1', ...accountEnv },
						completed: adapter.signInCompleted ? () => adapter.signInCompleted!(startedAt, accountEnv) : undefined,
					});
					const url = await login.url;
					if (url) {
						logins.set(adapter.id, login);
						control.reportSignInUrl(adapter.id, { url, message: 'Open this page, sign in, then paste the code it shows below.', codeEntry: true });
						try {
							const result = await login.done;
							if (result.ok) {
								await service.restart();
							}
							return result;
						} finally {
							if (logins.get(adapter.id) === login) {
								logins.delete(adapter.id);
							}
							control.reportSignInUrl(adapter.id, undefined);
						}
					}
					login.cancel();
					// The program could not start or printed no address, so the page hands over the command to run by hand.
					let command = ['node', `"${launch.entryPath}"`, ...terminal.terminalCommand].join(' ');
					let where = 'one';
					if (adapter.accountName && adapter.accounts) {
						// The account keeps its own sign-in in a folder the variables name, so the command sets them first.
						command = Object.entries(accountEnv)
							.map(([name, value]) => `$env:${name}='${value.replace(/'/g, "''")}'; `)
							.join('') + command;
						where = 'a PowerShell terminal (it is a PowerShell command)';
					}
					return { ok: false, message: `This server could not run the sign-in itself. Run this in ${where}, then choose Refresh usage: ${command}` };
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
			accountAdded: adapter => addAccountAdapter(adapter),
			accountRemoved: accountId => removeAccountAdapter(accountId),
		},
	});

	return {
		host,
		adapters,
		serviceOf: agentId => services.get(agentId),
		addAccountAdapter,
		removeAccountAdapter,
		control,
		usage,
		ledger,
		usageHistory,
		transcriptOptions,
		reportedWindowsOf: agentId => windowsOf(agentId),
		close: async () => {
			await Promise.all([...services.values()].map(service => service.close()));
			// The turns of the last couple of seconds are still in memory; they reach the folder before the process goes.
			await ledger.close();
		},
	};
}
