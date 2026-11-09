import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/claude';
import { googleAdapter } from '../../../src/adapters/google';
import type { ConversationForker } from '../../../src/core/adapter';
import { ADAPTERS } from '../../../src/core/agents';
import { policyOf, type ContinuationInput, type SessionPolicy } from '../../../src/core/sessionPolicy';
import type { SavedSession } from '../../../src/core/sessionStore';

/** The stored conversation every plan in this suite continues. */
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

/** Stands in for the forker the core holds when the adapter names one. */
const fakeForker: ConversationForker = {
	locate: async () => undefined,
	fork: async () => ({ sessionId: 'forked' }),
	missing: { message: 'missing', helpLabel: 'get it', helpUrl: 'https://example.com', declineLabel: 'not now' },
};

function input(overrides: Partial<ContinuationInput>): ContinuationInput {
	return { saved, live: [], editedOwnChat: true, agentSupportsFork: false, externalForker: undefined, ...overrides };
}

/**
 * Runs every combination of inputs the core can pass and holds the policy to a plan the core can
 * execute: a plan it names a branch for, and an external fork only where a forker was offered.
 */
function expectExecutablePlans(policy: SessionPolicy, label: string): void {
	for (const agentSupportsFork of [true, false]) {
		for (const externalForker of [undefined, fakeForker]) {
			for (const editedOwnChat of [true, false]) {
				const plan = policy.planContinuation(input({ editedOwnChat, agentSupportsFork, externalForker }));
				expect(['resume', 'fork-native', 'fork-external', 'rebuild'], label).toContain(plan.how);
				if (plan.how === 'fork-external') {
					expect(externalForker, `${label} plans an external fork without a forker`).toBeDefined();
				}
			}
		}
	}
}

/** The source of a bundled adapter, by the convention that its id names its file. */
function sourceOf(id: string): string {
	const file = join('src', 'adapters', `${id}.ts`);
	expect(existsSync(file), `${id} has no source at ${file}`).toBe(true);
	return readFileSync(file, 'utf8');
}

describe('every adapter against the session-policy contract', () => {
	for (const adapter of ADAPTERS) {
		describe(adapter.id, () => {
			it('resolves a session policy, even when the adapter declares none', () => {
				expect(policyOf(adapter)).toBeDefined();
				expect(policyOf({ ...adapter, sessionPolicy: undefined })).toBeDefined();
			});

			it('plans a continuation for every combination the core can pass', () => {
				expectExecutablePlans(policyOf(adapter), adapter.id);
			});

			it('plans a continuation for every combination the core can pass when it declares no policy', () => {
				expectExecutablePlans(policyOf({ ...adapter, sessionPolicy: undefined }), adapter.id);
			});

			it('returns a usable tool wait', () => {
				expect(policyOf(adapter).toolWaitMs({})).not.toBeNaN();
			});

			it('answers what an open and a fork are allowed to do', () => {
				const policy = policyOf(adapter);
				const prompt = policy.promptForOpen({ savedPrompt: 'saved', rebuilt: 'rebuilt' });
				expect(prompt, `${adapter.id} opens with neither the saved nor the rebuilt prompt`).toMatch(/^(saved|rebuilt)$/);
				expect(['reopen', 'list-changed']).toContain(policy.toolsChangedAction());
				for (const agentSupportsFork of [true, false]) {
					expect(typeof policy.canFork({ agentSupportsFork })).toBe('boolean');
				}
			});

			it('names no other agent', () => {
				const text = sourceOf(adapter.id);
				for (const other of ADAPTERS.filter(candidate => candidate.id !== adapter.id)) {
					expect(text, `${adapter.id} names ${other.id}`).not.toMatch(new RegExp(`['"\`]${other.id}['"\`]`));
				}
			});
		});
	}
});

describe('policies that lean on the native defaults', () => {
	it('google keeps the native action, wait and saved prompt, and always forks', () => {
		const policy = policyOf(googleAdapter);
		expect(policy.toolsChangedAction()).toBe('reopen');
		expect(policy.toolWaitMs({})).toBe(Number.POSITIVE_INFINITY);
		expect(policy.keepsSavedPrompt).toBe(true);
		expect(policy.canFork({ agentSupportsFork: false })).toBe(true);
	});

	it('claude takes a changed tool list in place and keeps no saved prompt', () => {
		const policy = policyOf(claudeAdapter);
		expect(policy.toolsChangedAction()).toBe('list-changed');
		expect(policy.keepsSavedPrompt).toBe(false);
	});
});
