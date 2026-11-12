import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { killTree, trackChild } from '../core/processHost';

/**
 * The folder under `~/.gemini` where `agy acp` keeps its conversations. The language server that
 * forks them and reads the quota must use the same one.
 */
export const APP_DATA_DIR = 'antigravity-copilot';

const HUB_START_TIMEOUT_MS = 20_000;
const HUB_REQUEST_TIMEOUT_MS = 60_000;
const LANGUAGE_SERVER = 'exa.language_server_pb.LanguageServerService';

/** A language server of the CLI that is running on a loopback port, and how to stop it. */
export interface Hub {
	readonly port: number;
	readonly token: string;
	stop(): Promise<void>;
}

function freePort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

function listening(port: number): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

/** How the hub is started: the program to run, its arguments, and whether the command line is already quoted. */
export interface HubCommand {
	readonly command: string;
	readonly args: string[];
	/** Set when `args` are a command line of their own, quoted here rather than by `spawn`. */
	readonly verbatim?: boolean;
}

/** Quotes one argument the way `cmd.exe` reads it, for the wrapper below. */
function quoteForCmd(argument: string): string {
	return /[\s"]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument;
}

/**
 * The command that starts the CLI's hub. On Windows it goes through `cmd.exe`: a `cmd` started
 * hidden owns an invisible console, and the CLI inherits it, whereas a CLI started with no console
 * allocates one of its own, which Windows hands to the default terminal — a window that flashes over
 * the desktop for as long as the hub runs.
 */
export function hubCommand(agy: string, args: readonly string[], platform: NodeJS.Platform = process.platform): HubCommand {
	if (platform !== 'win32') {
		return { command: agy, args: [...args] };
	}
	// `cmd /s /c ""program" args"`: cmd strips the outer pair of quotes, which leaves the program
	// quoted, so a folder with a space in it still runs.
	const line = `"${agy}" ${args.map(quoteForCmd).join(' ')}`;
	return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * Starts the CLI's own language server on a port of its own, behind a token made for this run. The
 * server the IDE runs, and its token, are never used.
 */
export async function startHub(agy: string, cwd: string): Promise<Hub> {
	const port = await freePort();
	const token = crypto.randomUUID();
	const launch = hubCommand(agy, ['--hub', `--hub-port=${port}`, `--csrf_token=${token}`, `--app_data_dir=${APP_DATA_DIR}`, `--add-dir=${cwd}`]);
	const child = cp.spawn(launch.command, launch.args, {
		cwd,
		// The hub would otherwise start `agy --bg-updater` now and then, which runs `agy --version` in a
		// console of its own that Windows Terminal shows as a flashing window. The extension updates the CLI itself.
		env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
		stdio: 'ignore',
		windowsHide: true,
		...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
		detached: process.platform !== 'win32',
	});
	if (child.pid) {
		trackChild(child.pid);
	}
	const hub: Hub = { port, token, stop: async () => { if (child.pid) { await killTree(child.pid); } } };
	child.once('error', () => undefined);
	const deadline = Date.now() + HUB_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			break;
		}
		if (await listening(port)) {
			return hub;
		}
		await new Promise<void>(resolve => setTimeout(resolve, 150));
	}
	await hub.stop();
	throw new Error('The Antigravity CLI did not start its language server.');
}

export async function callHub(hub: Hub, method: string, body: object): Promise<unknown> {
	const response = await fetch(`http://127.0.0.1:${hub.port}/${LANGUAGE_SERVER}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': hub.token },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`The Antigravity CLI answered ${method} with HTTP ${response.status}: ${text.slice(0, 200)}`);
	}
	return JSON.parse(text);
}
