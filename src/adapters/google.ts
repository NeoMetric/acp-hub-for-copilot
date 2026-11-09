import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AcpAuthMethod } from '../core/agentClient';
import type { AgentAdapter, AgentSettings, InstallContext, LaunchContext, LaunchSpec, SessionParamsInput } from '../core/adapter';
import { HOST_IDENTITY } from '../core/hostIdentity';
import { REGISTRY, registryAgent } from '../core/registry';
import { vendorOf } from '../core/vendors';
import { AGY_VERSION, AgyInstaller } from './googleCli';
import { googleForker } from './googleFork';
import { APP_DATA_DIR } from './googleHub';
import { googleModelPolicy } from './googleModels';
import { mapQuotaError } from './googleQuota';
import { lastModelCallOf, transcriptFile } from './googleTranscript';
import { googleUsage } from './googleUsage';
import { booleanSetting, stringListSetting, stringSetting } from './settingValues';

const ID = 'google';

/** Environment variables the agent reads an API key or Vertex AI setup from. */
const API_KEY_VARIABLES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/** Arguments that are safe to hand to `cmd.exe` unquoted. */
const SHELL_SAFE_ARGUMENT = /^[\w@+=:,./\\-]+$/;

/**
 * Runs the Antigravity CLI as an ACP server, on conversations of its own. One process serves every
 * conversation, which is what makes opening a chat take milliseconds. The process keeps a
 * conversation it opened in memory and never reads it again, so a fork that rewinds the source on
 * disk (to keep its prompt cache, see `googleFork`) restarts the agent instead.
 */
const ACP_ARGS = ['acp', `--app-data-dir=${APP_DATA_DIR}`];

/**
 * The agent the CLI runs for chats that use the Copilot tools. Its file sits in the CLI's global
 * agents folder, and its `tools` allowlist is what turns Antigravity's own tools off: the CLI
 * ignores `_meta.antigravity.disabledTools`. Its body replaces the section holding Antigravity's own
 * identity, which the CLI generates and cannot be reused, so the body states the persona instead;
 * the sections about its skills, artifacts and messaging stay. A name the CLI does not find is
 * ignored without an error, which is why the file is written before every start.
 */
const CUSTOM_AGENT = 'acp-hub-copilot';

/** The persona the agent keeps while Copilot's guidance is appended to it. */
const ANTIGRAVITY_PERSONA = 'You are Antigravity, an agentic coding assistant working with the user on their coding task in this workspace.';

export interface CustomAgentOptions {
	/** Write the empty `tools` allowlist, so the agent has none of Antigravity's tools. */
	noBuiltInTools: boolean;
	/** Replace the persona with the identity of the host, for a chat that replaces the prompt. */
	replacePrompt: boolean;
}

/** The `agent.md` of {@link CUSTOM_AGENT}. */
export function customAgentFile(options: CustomAgentOptions): string {
	const lines = ['---', `name: ${CUSTOM_AGENT}`, 'description: Created by the ACP Hub for Copilot extension to run chats on the chat\'s own tools.'];
	if (options.noBuiltInTools) {
		lines.push('tools: []');
	}
	lines.push('---', '', options.replacePrompt ? HOST_IDENTITY : ANTIGRAVITY_PERSONA);
	return `${lines.join('\n')}\n`;
}

/** Writes the agent into the CLI's gemini home. */
function writeCustomAgent(geminiHome: string, options: CustomAgentOptions): void {
	const directory = path.join(geminiHome, 'agents', CUSTOM_AGENT);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, 'agent.md'), customAgentFile(options));
}

/**
 * `agy acp` takes no list of tools to turn off, so the model is told instead. The chat tools are
 * listed to it as `mcp_vscode_<name>`.
 */
const BUILT_IN_TOOLS_OFF = 'Your own built-in tools are turned off for this chat: use only the `mcp_vscode_*` tools.';

/** A program found on disk, and whether it needs a shell to start. */
export interface ResolvedCommand {
	file: string;
	/** Windows `.cmd` and `.bat` shims (what `npm install -g` creates) cannot be started without a shell. */
	viaShell: boolean;
}

/** Looks `command` up the way a shell would: a path as given, otherwise the PATH entries in order. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ResolvedCommand | undefined {
	const windows = platform === 'win32';
	const extensions = windows
		? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
		: [''];
	const hasPath = command.includes('/') || command.includes('\\');
	const directories = hasPath ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);

	for (const directory of directories) {
		const base = directory ? path.join(directory, command) : command;
		const candidates = [base];
		if (windows) {
			candidates.push(...extensions.map(extension => base + extension));
		}
		for (const candidate of candidates) {
			if (isFile(candidate)) {
				return { file: candidate, viaShell: windows && /\.(cmd|bat)$/i.test(candidate) };
			}
		}
	}
	return undefined;
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/** Checks the arguments of a program that will go through `cmd.exe`, where quoting cannot be trusted. */
export function assertShellSafe(args: readonly string[]): void {
	for (const argument of args) {
		if (!SHELL_SAFE_ARGUMENT.test(argument)) {
			throw new Error(`The argument "${argument}" cannot be passed to a .cmd launcher. Point the agent command setting at the .exe or .js entry point instead.`);
		}
	}
}

function usesSignedInAccountOnly(settings: AgentSettings): boolean {
	return stringSetting(settings, 'authPreference', 'auto') === 'oauth';
}

/**
 * The program and arguments for the settings. Without a command override the
 * downloaded CLI runs as `agy acp`. An override is looked up on PATH and started
 * directly with its arguments as an array, so nothing in them is interpreted
 * by a shell; only a Windows `.cmd` or `.bat` file needs `cmd.exe`, and then
 * only plain arguments are accepted.
 */
export function googleLaunchSpec(ctx: LaunchContext, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string = os.homedir()): LaunchSpec {
	const launchEnv: Record<string, string> = {};
	if (ctx.apiKey && !usesSignedInAccountOnly(ctx.settings)) {
		launchEnv.GEMINI_API_KEY = ctx.apiKey;
	}

	// Antigravity's own tools come from its own agent; the chat's tools need the extension's agent,
	// whose `tools: []` is the only way to turn them off.
	const noBuiltInTools = !booleanSetting(ctx.settings, 'useAgentBuiltInTools');
	const replacePrompt = booleanSetting(ctx.settings, 'replaceSystemPrompt');
	const customAgent = noBuiltInTools || replacePrompt;
	if (customAgent) {
		writeCustomAgent(env.GEMINI_HOME || path.join(home, '.gemini'), { noBuiltInTools, replacePrompt });
	}
	const withAgent = (args: string[]) => customAgent ? [...args, `--agent=${CUSTOM_AGENT}`] : args;

	const command = stringSetting(ctx.settings, 'command').trim();
	if (command === '') {
		return { command: ctx.entryPath, args: withAgent(ACP_ARGS), env: launchEnv };
	}

	const configuredArgs = stringListSetting(ctx.settings, 'args');
	const args = withAgent(configuredArgs.length > 0 ? configuredArgs : ACP_ARGS);
	const found = resolveCommand(command, env, platform);
	if (!found) {
		// Starting it fails with "not found", which is the message the user needs.
		return { command, args, env: launchEnv };
	}
	if (found.viaShell) {
		assertShellSafe(args);
		return { command: found.file, args, env: launchEnv, shell: true };
	}
	return { command: found.file, args, env: launchEnv };
}

function launch(ctx: LaunchContext): LaunchSpec {
	return googleLaunchSpec(ctx, process.env, process.platform);
}

function mergeConfig(settings: AgentSettings, env: Record<string, string>): Record<string, string> {
	if (!usesSignedInAccountOnly(settings)) {
		return env;
	}
	const merged = { ...env };
	for (const name of API_KEY_VARIABLES) {
		delete merged[name];
	}
	return merged;
}

/** The method for ACP `authenticate`, which the server wants before it creates a session. */
export function authenticateMethodFor(advertised: readonly AcpAuthMethod[], hasApiKey: boolean): string | undefined {
	const ids = advertised.map(method => method.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
	if (hasApiKey && ids.includes('gemini-api-key')) {
		return 'gemini-api-key';
	}
	return ids.find(id => id !== 'gemini-api-key') ?? ids[0];
}

function authenticate(methods: AcpAuthMethod[], apiKey: string | undefined, settings: AgentSettings = {}): { methodId: string } | undefined {
	const methodId = authenticateMethodFor(methods, apiKey !== undefined && !usesSignedInAccountOnly(settings));
	return methodId ? { methodId } : undefined;
}

/**
 * The session prompt goes in `_meta.antigravity.systemPrompt.append`. It depends only on the chat and
 * the settings, never on the turn, so a resumed or forked session sends the same bytes and keeps its
 * prompt cache.
 */
function sessionParams(input: SessionParamsInput): Record<string, unknown> {
	const parts = [input.systemPromptAppend, input.disableBuiltInTools ? BUILT_IN_TOOLS_OFF : undefined].filter((part): part is string => !!part);
	if (parts.length === 0) {
		return {};
	}
	return { _meta: { antigravity: { systemPrompt: { append: parts.join('\n\n') } } } };
}

const installer = (ctx: InstallContext): AgyInstaller => new AgyInstaller(ctx.storageDir, ctx.log);

/** The pinned CLI, or an earlier one that stays usable until the update is installed. */
async function findCli(ctx: InstallContext): Promise<string | undefined> {
	const found = installer(ctx);
	return await found.find() ?? await found.findPrevious();
}

/** Whether something older is installed and the pinned CLI is not, so the update is worth fetching unasked. */
async function cliNeedsUpdate(ctx: InstallContext): Promise<boolean> {
	const found = installer(ctx);
	return await found.find() === undefined && await found.hasOlderInstall();
}

async function installCli(ctx: InstallContext): Promise<string> {
	let reportedPercent = -1;
	return installer(ctx).install((received, total) => {
		if (!total) {
			return;
		}
		const percent = Math.floor(received * 100 / total);
		if (percent === reportedPercent) {
			return;
		}
		reportedPercent = percent;
		ctx.progress(`Downloading the Antigravity CLI: ${percent}%`, percent);
	});
}

const registry = registryAgent(ID);

export const googleAdapter: AgentAdapter = {
	id: ID,
	displayName: registry.displayName,
	vendor: vendorOf(ID),
	install: { kind: 'download', version: AGY_VERSION, find: findCli, needsUpdate: cliNeedsUpdate, install: installCli },
	launch,
	findCommandOverride: settings => stringSetting(settings, 'command').trim() || undefined,
	auth: [
		{ kind: 'oauth-browser', label: 'Google account', browserAuthPreference: 'oauth' },
		{ kind: 'api-key', label: 'Gemini API key', envVar: 'GEMINI_API_KEY', keyPrefix: 'AIza' },
	],
	settings: [...REGISTRY.commonSettings, ...registry.settings],
	modelPolicy: googleModelPolicy,
	usage: googleUsage,
	systemPrompt: {
		toolAccess: 'The tools of the MCP server named `vscode` are VS Code\'s own and act on the user\'s workspace; you see them as `mcp_vscode_<name>`.',
		listRequiredArguments: true,
	},
	rebuildExpiredSessions: true,
	// `agy acp` sends no usage_update and reports only the sums of a turn over ACP; its own record of
	// the conversation has the tokens of each model call.
	lastModelCall: async sessionId => {
		const file = transcriptFile(sessionId);
		return file ? lastModelCallOf(file) : undefined;
	},
	// `agy acp` cannot fork a session; the CLI's language server copies the conversation instead.
	forker: googleForker,
	// Rewinding the source needs the agent to read it afresh, which one process does only on a restart.
	restartAfterFork: true,
	// `agy acp` applies the prompt of the request each time it opens a session, so a rebuilt one misses the cache.
	keepsSessionPrompt: true,
	// The agent saves a tool result of about 4,000 characters or more to a file and hands the model only its path. With its own
	// file tools off the model then reasons for minutes about how to get at the content, so results are cut below that size.
	maxToolResultChars: 3_500,
	disableBuiltInTools: settings => !booleanSetting(settings, 'useAgentBuiltInTools'),
	mapError: mapQuotaError,
	mergeConfig,
	sessionParams,
	authenticate,
};
