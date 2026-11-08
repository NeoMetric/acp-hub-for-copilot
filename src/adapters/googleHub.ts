import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { killTree, trackChild } from '../core/processes';

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

/**
 * Starts the CLI's own language server on a port of its own, behind a token made for this run. The
 * server the IDE runs, and its token, are never used.
 */
export async function startHub(agy: string, cwd: string): Promise<Hub> {
	const port = await freePort();
	const token = crypto.randomUUID();
	const child = cp.spawn(agy, ['--hub', `--hub-port=${port}`, `--csrf_token=${token}`, `--app_data_dir=${APP_DATA_DIR}`, `--add-dir=${cwd}`], {
		cwd,
		stdio: 'ignore',
		windowsHide: true,
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
