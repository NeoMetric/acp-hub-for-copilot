import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findAgy, forkConversation, forkStepIndex, type ForkEnvironment, type HubStep } from '../../../src/adapters/googleFork';
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

describe('findAgy', () => {
	it('tries configured command, PATH and installer location in order, skipping failed candidates', async () => {
		const home = path.join('test', 'lookup-home');
		const installed = path.join(home, '.gemini', 'bin', 'agy.exe');
		const answersVersion = vi.fn(async (file: string) => file === installed);
		const findOnPath = vi.fn((command: string) => command === 'custom-agy' ? 'configured-candidate' : 'path-candidate');
		const exists = vi.fn(() => true);
		expect(await findAgy({ agyCommand: ' custom-agy ' }, { home, platform: 'win32', findOnPath, exists, answersVersion })).toBe(installed);
		expect(answersVersion.mock.calls.map(([file]) => file)).toEqual(['configured-candidate', 'path-candidate', installed]);
	});

	it('returns undefined without launching missing candidates', async () => {
		const answersVersion = vi.fn(async () => true);
		expect(await findAgy({}, { home: 'not-a-home', findOnPath: () => undefined, exists: () => false, answersVersion })).toBeUndefined();
		expect(answersVersion).not.toHaveBeenCalled();
	});

	it('checks a duplicated failed candidate only once', async () => {
		const candidate = `candidate-${randomUUID()}`;
		const answersVersion = vi.fn(async () => false);
		expect(await findAgy({ agyCommand: candidate }, {
			home: 'unused-home', findOnPath: () => candidate, exists: file => file === candidate, answersVersion,
		})).toBeUndefined();
		expect(answersVersion).toHaveBeenCalledOnce();
	});

	it('caches a successful version check', async () => {
		const candidate = `candidate-${randomUUID()}`;
		const answersVersion = vi.fn(async () => true);
		const lookup = { home: 'unused-home', findOnPath: () => candidate, exists: () => true, answersVersion };
		expect(await findAgy({ agyCommand: candidate }, lookup)).toBe(candidate);
		expect(await findAgy({ agyCommand: candidate }, lookup)).toBe(candidate);
		expect(answersVersion).toHaveBeenCalledOnce();
	});

	it('checks a real program with --version', async () => {
		expect(await findAgy({ agyCommand: process.execPath }, { findOnPath: () => undefined })).toBe(process.execPath);
	});
});

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) { fs.rmSync(root, { recursive: true, force: true }); }
});

function harness(steps: HubStep[] = [response('answer')]) {
	const home = path.resolve('test', `.google-fork-${randomUUID()}`);
	roots.push(home);
	const conversations = path.join(home, '.gemini', 'antigravity-acp', 'conversations');
	fs.mkdirSync(conversations, { recursive: true });
	const request: ConversationForkRequest = { sessionId: 'source', cwd: path.resolve('test'), point: point('answer') };
	const stop = vi.fn(async () => undefined);
	const hub = { port: 1234, token: 'test-token', stop };
	const startHub = vi.fn(async () => hub);
	const call = vi.fn(async (_hub: typeof hub, method: string, _body: object): Promise<unknown> => {
		if (method === 'GetCascadeTrajectorySteps') { return { steps }; }
		if (method === 'ForkConversation') { return { newCascadeId: 'copy', forkedAtStepIndex: 0 }; }
		throw new Error(`Unexpected method ${method}`);
	});
	const environment: ForkEnvironment = { home, startHub, call };
	const log = vi.fn();
	return { home, conversations, request, stop, hub, startHub, call, environment, log };
}

describe('forkConversation', () => {
	it('forks at the matching occurrence, stops the hub, and writes the ACP folder metadata', async () => {
		const h = harness([response('answer'), response('other'), response('answer')]);
		const request = { ...h.request, point: point('answer', 2) };
		fs.writeFileSync(path.join(h.conversations, 'copy.db'), 'conversation');
		h.call.mockImplementation(async (_hub, method) => method === 'GetCascadeTrajectorySteps'
			? { steps: [response('answer'), response('other'), response('answer')] }
			: { newCascadeId: 'copy', forkedAtStepIndex: 2 });
		h.stop.mockImplementation(async () => {
			expect(fs.existsSync(path.join(h.conversations, 'copy.meta'))).toBe(false);
		});
		expect(await forkConversation('agy', request, h.log, h.environment)).toBe('copy');
		expect(h.startHub).toHaveBeenCalledWith('agy', request.cwd);
		expect(h.call.mock.calls).toEqual([
			[h.hub, 'GetCascadeTrajectorySteps', { cascadeId: 'source' }],
			[h.hub, 'ForkConversation', { sourceCascadeId: 'source', forkAtStepIndex: 2 }],
		]);
		expect(h.stop).toHaveBeenCalledOnce();
		expect(JSON.parse(fs.readFileSync(path.join(h.conversations, 'copy.meta'), 'utf8'))).toEqual({ cwd: request.cwd });
	});

	it('does not fork if the message cannot be located, and stops the hub', async () => {
		const h = harness([response('other')]);
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('No step');
		expect(h.call).toHaveBeenCalledOnce();
		expect(h.stop).toHaveBeenCalledOnce();
		expect(fs.readdirSync(h.conversations)).toEqual([]);
	});

	it.each([undefined, '', 'source', 42])('rejects an invalid new conversation id %s', async id => {
		const h = harness();
		h.call.mockImplementation(async (_hub, method) => method === 'GetCascadeTrajectorySteps' ? { steps: [response('answer')] } : { newCascadeId: id });
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('id of a new conversation');
		expect(h.stop).toHaveBeenCalledOnce();
		expect(fs.readdirSync(h.conversations)).toEqual([]);
	});

	it.each(['GetCascadeTrajectorySteps', 'ForkConversation'])('stops the hub when %s fails', async failedMethod => {
		const h = harness();
		h.call.mockImplementation(async (_hub, method) => {
			if (method === failedMethod) { throw new Error('hub failed'); }
			return { steps: [response('answer')] };
		});
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('hub failed');
		expect(h.stop).toHaveBeenCalledOnce();
		expect(fs.readdirSync(h.conversations)).toEqual([]);
	});

	it('does not write metadata when the fork database is missing', async () => {
		const h = harness();
		await expect(forkConversation('agy', h.request, h.log, h.environment)).rejects.toThrow('no conversation file');
		expect(h.stop).toHaveBeenCalledOnce();
		expect(fs.readdirSync(h.conversations)).toEqual([]);
	});

	it('rejects a server-reported fork at a different step', async () => {
		const h = harness();
		fs.writeFileSync(path.join(h.conversations, 'copy.db'), 'conversation');
		h.call.mockImplementation(async (_hub, method) => method === 'GetCascadeTrajectorySteps' ? { steps: [response('answer')] } : { newCascadeId: 'copy', forkedAtStepIndex: 9 });
		const result = await forkConversation('agy', h.request, h.log, h.environment).then(() => 'resolved', () => 'rejected');
		expect(h.stop).toHaveBeenCalledOnce();
		expect.soft(fs.existsSync(path.join(h.conversations, 'copy.meta'))).toBe(false);
		expect(result).toBe('rejected');
	});

	it('rejects a fork id that escapes the conversations directory', async () => {
		const h = harness();
		fs.writeFileSync(path.join(h.conversations, '..', 'outside.db'), 'outside');
		h.call.mockImplementation(async (_hub, method) => method === 'GetCascadeTrajectorySteps' ? { steps: [response('answer')] } : { newCascadeId: '../outside' });
		const result = await forkConversation('agy', h.request, h.log, h.environment).then(() => 'resolved', () => 'rejected');
		expect(h.stop).toHaveBeenCalledOnce();
		expect.soft(fs.existsSync(path.join(h.conversations, '..', 'outside.meta'))).toBe(false);
		expect(result).toBe('rejected');
	});
});
