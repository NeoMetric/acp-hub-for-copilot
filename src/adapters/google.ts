import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AcpAuthMethod } from '../core/agentClient';
import type { AgentAdapter, AgentSettings, InstallContext, LaunchContext, LaunchSpec, SessionParamsInput } from '../core/adapter';
import { REGISTRY, registryAgent } from '../core/registry';
import { vendorOf } from '../core/vendors';
import { googleModelPolicy } from './googleModels';
import { mapQuotaError } from './googleQuota';
import { SERVER_VERSION, ServerInstaller, serverArchiveFor } from './googleServer';
import { booleanSetting, stringListSetting, stringSetting } from './settingValues';

const ID = 'google';

/** Environment variables the ACP servers read an API key or Vertex AI setup from. */
const API_KEY_VARIABLES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/** Arguments that are safe to hand to `cmd.exe` unquoted. */
const SHELL_SAFE_ARGUMENT = /^[\w@+=:,./\\-]+$/;

/**
 * The built-in tools of the Antigravity server, by the exact names it reports them under. Sent as
 * `_meta.antigravity.disabledTools` so the agent can only use the tools of the chat. `finish` and
 * `ask_question` stay, as the agent needs them to end a turn and to ask the user.
 */
const DISABLED_BUILTIN_TOOLS = ['run_command', 'view_file', 'create_file', 'edit_file', 'list_directory', 'search_directory', 'find_file', 'search_web', 'read_url_content', 'generate_image', 'start_subagent'];

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
 * downloaded server runs. An override is looked up on PATH and started
 * directly with its arguments as an array, so nothing in them is interpreted
 * by a shell; only a Windows `.cmd` or `.bat` file needs `cmd.exe`, and then
 * only plain arguments are accepted.
 */
export function googleLaunchSpec(ctx: LaunchContext, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): LaunchSpec {
	const launchEnv: Record<string, string> = {
		GOOGLE_ACP_LOGS: path.join(ctx.storageDir, 'logs'),
	};
	if (ctx.apiKey && !usesSignedInAccountOnly(ctx.settings)) {
		launchEnv.GEMINI_API_KEY = ctx.apiKey;
	}

	const command = stringSetting(ctx.settings, 'command').trim();
	if (command === '') {
		return { command: ctx.entryPath, args: serverArchiveFor(platform)?.args ?? [], env: launchEnv };
	}

	const args = stringListSetting(ctx.settings, 'args');
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

function authenticate(methods: AcpAuthMethod[], apiKey: string | undefined): { methodId: string } | undefined {
	const methodId = authenticateMethodFor(methods, apiKey !== undefined);
	return methodId ? { methodId } : undefined;
}

function sessionParams(input: SessionParamsInput): Record<string, unknown> {
	const antigravity: Record<string, unknown> = {};
	if (input.disableBuiltInTools) {
		antigravity.disabledTools = DISABLED_BUILTIN_TOOLS;
	}
	if (input.systemPromptAppend) {
		antigravity.systemPrompt = { append: input.systemPromptAppend };
	}
	if (Object.keys(antigravity).length === 0) {
		return {};
	}
	return { _meta: { antigravity } };
}

const installer = (ctx: InstallContext): ServerInstaller => new ServerInstaller(ctx.storageDir, ctx.log);

async function findServer(ctx: InstallContext): Promise<string | undefined> {
	const server = await installer(ctx).find();
	return server?.file;
}

async function installServer(ctx: InstallContext): Promise<string> {
	let reportedPercent = -1;
	const server = await installer(ctx).install((received, total) => {
		if (!total) {
			return;
		}
		const percent = Math.floor(received * 100 / total);
		if (percent === reportedPercent) {
			return;
		}
		reportedPercent = percent;
		ctx.progress(`Downloading the Antigravity ACP server: ${percent}%`);
	});
	return server.file;
}

const registry = registryAgent(ID);

export const googleAdapter: AgentAdapter = {
	id: ID,
	displayName: registry.displayName,
	vendor: vendorOf(ID),
	install: { kind: 'download', version: SERVER_VERSION, find: findServer, install: installServer },
	launch,
	auth: [
		{ kind: 'oauth-browser', label: 'Google account' },
		{ kind: 'api-key', label: 'Gemini API key', envVar: 'GEMINI_API_KEY', keyPrefix: 'AIza' },
	],
	settings: [...REGISTRY.commonSettings, ...registry.settings],
	modelPolicy: googleModelPolicy,
	systemPrompt: {
		toolAccess: 'The tools of the MCP server named `vscode` are VS Code\'s own and act on the user\'s workspace; reach them only through `call_mcp_tool`.',
		listRequiredArguments: true,
	},
	rebuildExpiredSessions: true,
	disableBuiltInTools: settings => !booleanSetting(settings, 'useAgentBuiltInTools'),
	mapError: mapQuotaError,
	mergeConfig,
	sessionParams,
	authenticate,
};
