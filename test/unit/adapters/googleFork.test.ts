import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forkConversation, forkStepIndex, googleForker, type ForkEnvironment, type HubStep } from '../../../src/adapters/googleFork';
import { APP_DATA_DIR } from '../../../src/adapters/googleHub';
import type { ConversationForkRequest } from '../../../src/core/adapter';
import { messageFingerprintOf } from '../../../src/core/sessionStore';

const planner = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
const point = (text: string, occurrence = 1) => ({ messageId: 'message-id', messageFingerprint: messageFingerprintOf(text), messageOccurrence: occurrence });
const response = (text: string): HubStep => ({ type: planner, plannerResponse: { response: text } });

describe('forkStepIndex', () => {
	it('counts matching planner steps only, once per step, including modified responses', () => {
		const steps: HubStep[] = [
			{ type: 'OTHER', plannerResponse: { response: 'answer' } },
			{ type: planner, plannerResponse: { response: 'answer', modifiedResponse: 'answer' } },
			response('different'),
			{ type: planner, plannerResponse: { response: 'old', modifiedResponse: 'answer' } },
			response('answer'),
		];
		expect(forkStepIndex(steps, point('answer', 1))).toBe(1);
		expect(forkStepIndex(steps, point('answer', 2))).toBe(3);
		expect(forkStepIndex(steps, point('answer', 3))).toBe(4);
		expect(forkStepIndex(steps, point('answer', 4))).toBeUndefined();
	});

	it('requires the exact fingerprint and a nonempty planner response', () => {
		const steps: HubStep[] = [response(' answer '), response('  '), { type: planner }, response('answer')];
		expect(forkStepIndex(steps, point('answer'))).toBe(3);
		expect(forkStepIndex(steps, point(' answer '))).toBe(0);
		expect(forkStepIndex(steps, point('  '))).toBeUndefined();
		expect(forkStepIndex(steps, point('missing'))).toBeUndefined();
		expect(forkStepIndex(steps, point('answer', 0))).toBeUndefined();
	});
});

describe('googleForker.locate', () => {
	it('forks with the same agy the agent runs', async () => {
		expect(await googleForker.locate({}, vi.fn(), 'C:\\storage\\google\\v1.5.3\\agy.exe')).toBe('C:\\storage\\google\\v1.5.3\\agy.exe');
		expect(await googleForker.locate({}, vi.fn(), undefined)).toBeUndefined();
	});
});

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) { fs.rmSync(root, { recursive: true, force: true }); }
});

/**
 * A language server of the CLI as far as forking uses it: it lists the steps of the source,
 * copies the conversation (writing the copy's file) and rewinds the source, keeping steps
 * 0..stepIndex, as the real one does.
 */
function harness(steps: HubStep[] = [response('answer'), response('later')]) {
	const home = path.resolve('test', `.google-fork-${randomUUID()}`);
	roots.push(home);
	const conversations = path.join(home, '.gemini', APP_DATA_DIR, 'conversations');
	fs.mkdirSync(conversations, { recursive: true });
	const request: ConversationForkRequest = { sessionId: 'source', cwd: path.resolve('test'), point: point('answer'), keepSourceId: true };
	const stop = vi.fn(async () => undefined);
	const hub = { port: 1234, token: 'test-token', stop };
	const startHub = vi.fn(async () => hub);
	const server = { steps: [...steps], copyId: 'copy' as unknown, forkedAt: undefined as number | undefined, writesCopy: true, rewinds: true, fails: undefined as string | undefined, failures: [] as string[], deleted: [] as unknown[] };
	const call = vi.fn(async (_hub: typeof hub, method: string, body: Record<string, unknown>): Promise<unknown> => {
		if (method === server.fails) { throw new Error('hub failed'); }
		if (method !== 'DeleteCascadeTrajectory' && server.failures.length > 0 && method === server.failures[0].split('|')[0]) {
			throw new Error(server.failures.shift()!.split('|')[1]);
		}
		if (method === 'DeleteCascadeTrajectory') {
			server.deleted.push(body.cascadeId);
			fs.rmSync(path.join(conversations, `${body.cascadeId}.db`), { force: true });
			return {};
		}
		if (method === 'GetCascadeTrajectorySteps') { return { steps: server.steps }; }
		if (method === 'ForkConversation') {
			if (server.writesCopy && typeof server.copyId === 'string' && /^[\w-]+$/.test(server.copyId)) {
				fs.writeFileSync(path.join(conversations, `${server.copyId}.db`), 'conversation');
			}
			return { newCascadeId: server.copyId, forkedAtStepIndex: server.forkedAt ?? body.forkAtStepIndex };
		}
		if (method === 'RevertToCascadeStep') {
			if (server.rewinds) { server.steps = server.steps.slice(0, (body.stepIndex as number) + 1); }
			return { metadata: {} };
		}
		throw new Error(`Unexpected method ${method}`);
	});
	const wait = vi.fn(async () => undefined);
	const environment: ForkEnvironment = { home, startHub, call, wait };
	const log = vi.fn();
	return { home, conversations, request, stop, hub, startHub, call, server, environment, log, wait };
}

describe('forkConversation', () => {
	it('keeps the source id for the fork: the whole conversation is copied for the source chat, then the source is rewound to the fork point', async () => {
		const h = harness([response('answer'), response('other'), response('answer'), response('later')]);
		const request = { ...h.request, point: point('answer', 2) };

		expect(await forkConversation('agy', request, h.log, h.environment)).toEqual({ sessionId: 'source', sourceMovedTo: 'copy' });

		expect(h.startHub).toHaveBeenCalledWith('agy', request.cwd);
		expect(h.call.mock.calls.map(([, method, body]) => [method, body])).toEqual([
			['GetCascadeTrajectorySteps', { cascadeId: 'source' }],
			['ForkConversation', { sourceCascadeId: 'source', forkAtStepIndex: 3 }],
			['RevertToCascadeStep', { cascadeId: 'source', stepIndex: 2, conversationOnly: true, suppressErrorStep: true }],
			['GetCascadeTrajectorySteps', { cascadeId: 'source' }],
		]);
		expect(h.server.steps).toHaveLength(3);
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it('takes an id of its own, and leaves the source alone, when the agent cannot read it afresh', async () => {
		const h = harness([response('answer'), response('other'), response('answer'), response('later')]);
		const request = { ...h.request, point: point('answer', 2), keepSourceId: false };

		expect(await forkConversation('agy', request, h.log, h.environment)).toEqual({ sessionId: 'copy' });

		expect(h.call.mock.calls.map(([, method, body]) => [method, body])).toEqual([
			['GetCascadeTrajectorySteps', { cascadeId: 'source' }],
			['ForkConversation', { sourceCascadeId: 'source', forkAtStepIndex: 2 }],
		]);
		expect(h.server.steps).toHaveLength(4);
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it('fails when the rewind did not take, so the chat is not continued on the whole conversation', async () => {
		const h = harness();
		h.server.rewinds = false;

		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('rewind');
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it('does not fork if the message cannot be located, and stops the hub', async () => {
		const h = harness([response('other')]);
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('No step');
		expect(h.call).toHaveBeenCalledOnce();
		expect(h.stop).toHaveBeenCalledOnce();
		expect(fs.readdirSync(h.conversations)).toEqual([]);
	});

	it.each([undefined, '', 'source', 42, '../outside'])('rejects an invalid id %s for the copy, and leaves the source as it was', async id => {
		const h = harness();
		h.server.copyId = id;
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('id of a new conversation');
		expect(h.server.steps).toHaveLength(2);
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it.each(['GetCascadeTrajectorySteps', 'ForkConversation', 'RevertToCascadeStep'])('stops the hub when %s fails', async failedMethod => {
		const h = harness();
		h.server.fails = failedMethod;
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('hub failed');
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it('leaves the source as it was when the hub wrote no file for the copy', async () => {
		const h = harness();
		h.server.writesCopy = false;
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('no conversation file');
		expect(h.server.steps).toHaveLength(2);
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it('leaves the source as it was when the copy is not the whole conversation', async () => {
		const h = harness();
		h.server.forkedAt = 0;
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('different step');
		expect(h.server.steps).toHaveLength(2);
	});

	it('tries the rewind again when the CLI is still loading its models, instead of giving up the cache', async () => {
		const h = harness();
		h.server.failures = ['RevertToCascadeStep|The Antigravity CLI answered RevertToCascadeStep with HTTP 500: unknown model key MODEL_PLACEHOLDER_M318: model not found'];

		expect(await forkConversation('agy', h.request, h.log, h.environment)).toEqual({ sessionId: 'source', sourceMovedTo: 'copy' });

		expect(h.call.mock.calls.filter(([, method]) => method === 'RevertToCascadeStep')).toHaveLength(2);
		expect(h.wait).toHaveBeenCalledOnce();
		expect(h.server.deleted).toEqual([]);
	});

	it('tries the copy again when the CLI cannot clone the conversation yet', async () => {
		const h = harness();
		h.server.failures = ['ForkConversation|internal: failed to create forked conversation: failed to clone trajectory'];

		expect(await forkConversation('agy', h.request, h.log, h.environment)).toEqual({ sessionId: 'source', sourceMovedTo: 'copy' });
		expect(h.call.mock.calls.filter(([, method]) => method === 'ForkConversation')).toHaveLength(2);
	});

	it('gives up on an error that keeps coming back, and does not retry other errors', async () => {
		const h = harness();
		h.server.failures = Array.from({ length: 10 }, () => 'RevertToCascadeStep|unknown model key X');
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('unknown model key');
		expect(h.call.mock.calls.filter(([, method]) => method === 'RevertToCascadeStep')).toHaveLength(4);

		const other = harness();
		other.server.failures = ['RevertToCascadeStep|step_index out of bounds'];
		await expect(forkConversation('agy', other.request, other.log, other.environment)).rejects.toThrow('out of bounds');
		expect(other.call.mock.calls.filter(([, method]) => method === 'RevertToCascadeStep')).toHaveLength(1);
		expect(other.wait).not.toHaveBeenCalled();
	});

	it('deletes the copy when the source could not be rewound, so failed forks do not pile up conversations', async () => {
		const h = harness();
		h.server.fails = 'RevertToCascadeStep';

		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('hub failed');

		expect(h.server.deleted).toEqual(['copy']);
		expect(fs.readdirSync(h.conversations)).toEqual([]);
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it('keeps the copy once the source was rewound, because it is then the only whole record of the conversation', async () => {
		const h = harness();
		const original = h.call.getMockImplementation()!;
		let rewound = false;
		h.call.mockImplementation(async (hub, method, body) => {
			if (method === 'RevertToCascadeStep') { rewound = true; }
			if (method === 'GetCascadeTrajectorySteps' && rewound) { throw new Error('hub failed'); }
			return original(hub, method, body);
		});

		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('hub failed');
		expect(h.server.deleted).toEqual([]);
	});
});
