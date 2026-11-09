import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude';
import type { ConversationForker } from '../../src/core/adapter';
import { nativeSessionPolicy } from '../../src/core/nativeSessionPolicy';
import { effectiveToolWaitMs, policyOf, type ContinuationInput, type SessionPolicy } from '../../src/core/sessionPolicy';
import type { SavedSession } from '../../src/core/sessionStore';

const saved: SavedSession = {
	key: 'chat',
	sessionId: 'saved-session',
	cwd: '/work',
	history: ['message'],
	toolsHash: 'tools',
	guidanceHash: 'guidance',
	promptHash: 'prompt',
	savedAt: 0,
};

const fakeForker: ConversationForker = {
	locate: async () => undefined,
	fork: async () => ({ sessionId: 'forked' }),
	missing: { message: 'missing', helpLabel: 'get it', helpUrl: 'https://example.com', declineLabel: 'not now' },
};

function input(overrides: Partial<ContinuationInput>): ContinuationInput {
	return { saved, live: [], editedOwnChat: true, agentSupportsFork: false, externalForker: undefined, ...overrides };
}

/** A policy that answers the given wait, so the clamp can be tested apart from the default. */
function policyReturning(value: number): SessionPolicy {
	return { ...nativeSessionPolicy, toolWaitMs: () => value };
}

describe('nativeSessionPolicy', () => {
	it('uses the agent fork when the agent advertises it', () => {
		expect(nativeSessionPolicy.planContinuation(input({ agentSupportsFork: true }))).toEqual({ how: 'fork-native' });
	});

	it('prefers the agent fork to the adapter forker', () => {
		expect(nativeSessionPolicy.planContinuation(input({ agentSupportsFork: true, externalForker: fakeForker }))).toEqual({ how: 'fork-native' });
	});

	it('uses the external forker when the adapter has one and the agent does not fork', () => {
		const plan = nativeSessionPolicy.planContinuation(input({ agentSupportsFork: false, externalForker: fakeForker }));
		expect(plan).toEqual({ how: 'fork-external', keepSourceId: false, restartFirst: false });
	});

	it('rebuilds when neither mechanism exists', () => {
		expect(nativeSessionPolicy.planContinuation(input({ agentSupportsFork: false }))).toEqual({ how: 'rebuild' });
	});

	it('opens the session with the rebuilt prompt', () => {
		expect(nativeSessionPolicy.promptForOpen({ savedPrompt: undefined, rebuilt: 'rebuilt' })).toBe('rebuilt');
		expect(nativeSessionPolicy.promptForOpen({ savedPrompt: undefined, rebuilt: undefined })).toBeUndefined();
	});

	it('ignores the saved prompt and still opens with the rebuilt one', () => {
		expect(nativeSessionPolicy.promptForOpen({ savedPrompt: 'saved', rebuilt: 'rebuilt' })).toBe('rebuilt');
	});

	it('reopens the session when its tools change', () => {
		expect(nativeSessionPolicy.toolsChangedAction()).toBe('reopen');
	});

	it('never disables the tool wait', () => {
		for (const value of [0, -1, Number.NaN]) {
			expect(nativeSessionPolicy.toolWaitMs({ toolWaitTimeoutMs: value })).toBeGreaterThan(0);
		}
		expect(nativeSessionPolicy.toolWaitMs({})).toBe(Number.POSITIVE_INFINITY);
		expect(nativeSessionPolicy.toolWaitMs({ toolWaitTimeoutMs: 2500 })).toBe(2500);
	});
});

describe('effectiveToolWaitMs', () => {
	it('leaves the wait unbounded when the policy answers no usable wait', () => {
		for (const value of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
			expect(effectiveToolWaitMs(policyReturning(value), {})).toBe(Number.POSITIVE_INFINITY);
		}
	});

	it('passes a positive finite wait through', () => {
		expect(effectiveToolWaitMs(policyReturning(5000), {})).toBe(5000);
		expect(effectiveToolWaitMs(nativeSessionPolicy, {})).toBe(Number.POSITIVE_INFINITY);
		expect(effectiveToolWaitMs(nativeSessionPolicy, { toolWaitTimeoutMs: 2500 })).toBe(2500);
	});
});

describe('policyOf', () => {
	it('uses the policy an adapter declares', () => {
		const declared = policyReturning(1000);
		expect(policyOf({ ...claudeAdapter, sessionPolicy: declared })).toBe(declared);
	});

	it('falls back to the native default for an adapter that declares none', () => {
		expect(policyOf({ ...claudeAdapter, sessionPolicy: undefined })).toBe(nativeSessionPolicy);
	});
});
