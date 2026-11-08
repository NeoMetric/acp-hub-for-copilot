import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConversationForkRequest, ConversationForker, ForkResult } from '../core/adapter';
import type { ForkPoint } from '../core/agentClient';
import type { Log } from '../core/logging';
import { messageFingerprintOf } from '../core/sessionStore';
import { APP_DATA_DIR, callHub, startHub, type Hub } from './googleHub';

const PLANNER_RESPONSE = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';

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

/** What forking needs from the machine; tests replace it. */
export interface ForkEnvironment {
	home: string;
	startHub(agy: string, cwd: string): Promise<Hub>;
	call(hub: Hub, method: string, body: object): Promise<unknown>;
}

const realEnvironment = (): ForkEnvironment => ({ home: os.homedir(), startHub, call: callHub });

async function stepsOf(environment: ForkEnvironment, hub: Hub, cascadeId: string): Promise<HubStep[]> {
	const trajectory = await environment.call(hub, 'GetCascadeTrajectorySteps', { cascadeId }) as { steps?: HubStep[] };
	return trajectory.steps ?? [];
}

/**
 * Forks an `agy acp` conversation with the CLI's language server, which works on the same
 * conversations. Antigravity writes the conversation id into the system prompt, so a copy under a
 * new id cannot reuse the cached prompt. The fork therefore keeps the source's id: the whole
 * conversation is first copied for the chats that had the source, then the source is rewound to the
 * fork point (its workspace files are left alone). The source must be closed in `agy acp`, which
 * then reads it again from disk when it is resumed.
 */
export async function forkConversation(agy: string, request: ConversationForkRequest, log: Log, environment: ForkEnvironment = realEnvironment()): Promise<ForkResult> {
	const source = request.sessionId;
	const hub = await environment.startHub(agy, request.cwd);
	try {
		const steps = await stepsOf(environment, hub, source);
		const index = forkStepIndex(steps, request.point);
		if (index === undefined) {
			throw new Error('No step of the conversation says what the fork point says.');
		}
		// Keeping the source's id needs the source rewound, which needs a process that reads it again.
		const cut = request.keepSourceId ? steps.length - 1 : index;
		const copied = await environment.call(hub, 'ForkConversation', { sourceCascadeId: source, forkAtStepIndex: cut }) as { newCascadeId?: unknown; forkedAtStepIndex?: unknown };
		const copy = copied.newCascadeId;
		if (typeof copy !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(copy) || copy === source) {
			throw new Error('The Antigravity CLI did not return the id of a new conversation.');
		}
		if ((copied.forkedAtStepIndex ?? 0) !== cut) {
			throw new Error('The Antigravity CLI copied the conversation at a different step.');
		}
		if (!fs.existsSync(path.join(environment.home, '.gemini', APP_DATA_DIR, 'conversations', `${copy}.db`))) {
			throw new Error('The Antigravity CLI left no conversation file for the copy.');
		}
		if (!request.keepSourceId) {
			log(`[reuse] The Antigravity CLI forked ${source} after step ${index} into ${copy}, which pays one cache miss.`, 'debug');
			return { sessionId: copy };
		}

		await environment.call(hub, 'RevertToCascadeStep', { cascadeId: source, stepIndex: index, conversationOnly: true, suppressErrorStep: true });
		if ((await stepsOf(environment, hub, source)).length !== index + 1) {
			throw new Error('The Antigravity CLI did not rewind the conversation to the fork point.');
		}
		log(`[reuse] The Antigravity CLI copied ${source} into ${copy} and rewound ${source} to step ${index}.`, 'debug');
		return { sessionId: source, sourceMovedTo: copy };
	} finally {
		await hub.stop();
	}
}

export const googleForker: ConversationForker = {
	// The agent itself is the Antigravity CLI, so the program that runs it also forks.
	locate: async (_settings, _log, agentProgram) => agentProgram,
	fork: (program, request, log) => forkConversation(program, request, log),
	missing: {
		message: 'Google Agent could not find the Antigravity CLI to continue this chat from an earlier message, so the chat is sent as a transcript.',
		helpLabel: 'Get Antigravity CLI',
		helpUrl: 'https://antigravity.google/download',
		declineLabel: 'Use transcript instead',
	},
};
