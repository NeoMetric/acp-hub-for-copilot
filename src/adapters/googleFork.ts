import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSettings, ConversationForkRequest, ConversationForker } from '../core/adapter';
import type { ForkPoint } from '../core/agentClient';
import { findOnPath } from '../core/installers';
import type { Log } from '../core/logging';
import { killTree, trackChild } from '../core/processes';
import { messageFingerprintOf } from '../core/sessionStore';
import { stringSetting } from './settingValues';

const HUB_START_TIMEOUT_MS = 20_000;
const HUB_REQUEST_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;
const PLANNER_RESPONSE = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
const LANGUAGE_SERVER = 'exa.language_server_pb.LanguageServerService';

/** Where Google's official download page, which has the Antigravity CLI, is. */
export const AGY_DOWNLOAD_URL = 'https://antigravity.google/download';

/** The program, found once and checked with `--version`, so a later fork does not start it just to ask. */
const verified = new Set<string>();

export interface AgyLookup {
	home?: string;
	platform?: NodeJS.Platform;
	findOnPath?(command: string): string | undefined;
	exists?(file: string): boolean;
	/** Whether the program starts and answers `--version`. */
	answersVersion?(file: string): Promise<boolean>;
}

function runsVersion(file: string): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		cp.execFile(file, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, error => resolve(!error));
	});
}

/**
 * The Antigravity CLI on this machine: the path in the `agyCommand` setting, then `agy` on the PATH,
 * then where Google's installer puts it (`~/.gemini/bin`). The first that answers `agy --version` wins.
 */
export async function findAgy(settings: AgentSettings, lookup: AgyLookup = {}): Promise<string | undefined> {
	const platform = lookup.platform ?? process.platform;
	const onPath = lookup.findOnPath ?? ((command: string) => findOnPath(command));
	const exists = lookup.exists ?? ((file: string) => fs.existsSync(file));
	const answers = lookup.answersVersion ?? runsVersion;
	const name = platform === 'win32' ? 'agy.exe' : 'agy';

	const candidates: string[] = [];
	const configured = stringSetting(settings, 'agyCommand').trim();
	if (configured) {
		candidates.push(configured.includes('/') || configured.includes('\\') ? configured : onPath(configured) ?? configured);
	}
	const found = onPath('agy');
	if (found) {
		candidates.push(found);
	}
	candidates.push(path.join(lookup.home ?? os.homedir(), '.gemini', 'bin', name));

	for (const candidate of new Set(candidates)) {
		if (!exists(candidate)) {
			continue;
		}
		if (verified.has(candidate) || await answers(candidate)) {
			verified.add(candidate);
			return candidate;
		}
	}
	return undefined;
}

/** What the hub reports for one step of a conversation; only the parts the fork point is found by. */
export interface HubStep {
	readonly type?: string;
	readonly plannerResponse?: { readonly response?: string; readonly modifiedResponse?: string };
}

/**
 * The index of the step that holds the agent message of a fork point: the `messageOccurrence`-th
 * reply of the planner whose text has the fingerprint. The conversation keeps every step up to and
 * including it. `undefined` when no step says that.
 */
export function forkStepIndex(steps: readonly HubStep[], point: ForkPoint): number | undefined {
	let seen = 0;
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		if (step.type !== PLANNER_RESPONSE) {
			continue;
		}
		const texts = [step.plannerResponse?.response, step.plannerResponse?.modifiedResponse];
		const says = texts.some(text => typeof text === 'string' && text.trim().length > 0 && messageFingerprintOf(text) === point.messageFingerprint);
		if (says && ++seen === point.messageOccurrence) {
			return index;
		}
	}
	return undefined;
}

/** A language server of the CLI that is running on a loopback port, and how to stop it. */
export interface Hub {
	readonly port: number;
	readonly token: string;
	stop(): Promise<void>;
}

/** What forking needs from the machine; tests replace it. */
export interface ForkEnvironment {
	home: string;
	startHub(agy: string, cwd: string): Promise<Hub>;
	call(hub: Hub, method: string, body: object): Promise<unknown>;
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
 * server the IDE runs, and its token, are never used. The conversations are the ones of the ACP
 * server, which `--app_data_dir` names.
 */
async function startHub(agy: string, cwd: string): Promise<Hub> {
	const port = await freePort();
	const token = crypto.randomUUID();
	const child = cp.spawn(agy, ['--hub', `--hub-port=${port}`, `--csrf_token=${token}`, '--app_data_dir=antigravity-acp', `--add-dir=${cwd}`], {
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

async function callHub(hub: Hub, method: string, body: object): Promise<unknown> {
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

const realEnvironment = (): ForkEnvironment => ({ home: os.homedir(), startHub, call: callHub });

/**
 * Copies the conversation of an ACP session up to the fork point, with the CLI's language server,
 * and makes the copy one the ACP server can open. The server runs only for the copy: it is started
 * here and stopped before this returns, since starting it touches the conversation files and the
 * source must be idle (closed) while it is copied.
 */
export async function forkConversation(agy: string, request: ConversationForkRequest, log: Log, environment: ForkEnvironment = realEnvironment()): Promise<string> {
	const hub = await environment.startHub(agy, request.cwd);
	let newId: string;
	try {
		const trajectory = await environment.call(hub, 'GetCascadeTrajectorySteps', { cascadeId: request.sessionId }) as { steps?: HubStep[] };
		const index = forkStepIndex(trajectory.steps ?? [], request.point);
		if (index === undefined) {
			throw new Error('No step of the conversation says what the fork point says.');
		}
		const forked = await environment.call(hub, 'ForkConversation', { sourceCascadeId: request.sessionId, forkAtStepIndex: index }) as { newCascadeId?: unknown; forkedAtStepIndex?: unknown };
		if (typeof forked.newCascadeId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(forked.newCascadeId) || forked.newCascadeId === request.sessionId) {
			throw new Error('The Antigravity CLI did not return the id of a new conversation.');
		}
		if ((forked.forkedAtStepIndex ?? 0) !== index) {
			throw new Error('The Antigravity CLI forked at a different step.');
		}
		newId = forked.newCascadeId;
		log(`[reuse] The Antigravity CLI forked ${request.sessionId} after step ${index} into ${newId}.`, 'debug');
	} finally {
		await hub.stop();
	}

	// The ACP server opens only conversations that have a record of their folder.
	const conversations = path.join(environment.home, '.gemini', 'antigravity-acp', 'conversations');
	if (!fs.existsSync(path.join(conversations, `${newId}.db`))) {
		throw new Error('The Antigravity CLI left no conversation file for the fork.');
	}
	await fs.promises.writeFile(path.join(conversations, `${newId}.meta`), JSON.stringify({ cwd: request.cwd }));
	return newId;
}

export const googleForker: ConversationForker = {
	locate: (settings, log) => findAgy(settings).then(found => {
		log(found ? `[reuse] Antigravity CLI for forking: ${found}` : '[reuse] The Antigravity CLI (agy) was not found.', 'debug');
		return found;
	}),
	fork: (program, request, log) => forkConversation(program, request, log),
	missing: {
		message: 'Google Agent can continue a chat from an earlier message (an edit, /fork or a side chat) without sending the whole chat again when the Antigravity CLI (agy) is installed. It was not found on this machine, so those chats are sent as a transcript.',
		helpLabel: 'Get Antigravity CLI',
		helpUrl: AGY_DOWNLOAD_URL,
		declineLabel: 'Use transcript instead',
	},
};
