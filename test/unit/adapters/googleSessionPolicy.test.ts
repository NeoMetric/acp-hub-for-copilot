import { describe, expect, it } from 'vitest';
import { googleSessionPolicy } from '../../../src/adapters/googleSessionPolicy';
import type { ConversationForker } from '../../../src/core/adapter';
import type { SavedSession } from '../../../src/core/sessionStore';

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

const forker: ConversationForker = {
	locate: async () => 'agy',
	fork: async () => ({ sessionId: 'copy' }),
	missing: { message: 'missing', helpLabel: 'Install', helpUrl: 'https://example.com', declineLabel: 'Use transcript' },
};

describe('googleSessionPolicy', () => {
	it('keeps the source id only when the chat edited its own earlier message and nothing else is mid-turn', () => {
		const plan = googleSessionPolicy.planContinuation({ saved, live: [], editedOwnChat: true, agentSupportsFork: false, externalForker: forker });
		expect(plan).toEqual({ how: 'fork-external', keepSourceId: true, restartFirst: true });
	});

	it('takes a new id when another chat is mid-turn', () => {
		const plan = googleSessionPolicy.planContinuation({ saved, live: [{ chatKey: 'b', sessionId: 'other', hasTurn: true }], editedOwnChat: true, agentSupportsFork: false, externalForker: forker });
		expect(plan).toEqual({ how: 'fork-external', keepSourceId: false, restartFirst: false });
	});

	it('takes a new id for a copy of another chat', () => {
		const plan = googleSessionPolicy.planContinuation({ saved, live: [], editedOwnChat: false, agentSupportsFork: false, externalForker: forker });
		expect(plan).toEqual({ how: 'fork-external', keepSourceId: false, restartFirst: false });
	});

	it('rebuilds without a forker, and reuses the saved prompt', () => {
		expect(googleSessionPolicy.planContinuation({ saved, live: [], editedOwnChat: true, agentSupportsFork: false, externalForker: undefined })).toEqual({ how: 'rebuild' });
		expect(googleSessionPolicy.promptForOpen({ savedPrompt: 'saved prompt', rebuilt: 'new' })).toBe('saved prompt');
		expect(googleSessionPolicy.promptForOpen({ savedPrompt: undefined, rebuilt: 'new' })).toBe('new');
		expect(googleSessionPolicy.keepsSavedPrompt).toBe(true);
	});

	it('uses its own forker even when the agent advertises a fork, and can always fork', () => {
		expect(googleSessionPolicy.planContinuation({ saved, live: [], editedOwnChat: true, agentSupportsFork: true, externalForker: forker })).toEqual({ how: 'fork-external', keepSourceId: true, restartFirst: true });
		expect(googleSessionPolicy.canFork({ agentSupportsFork: false })).toBe(true);
	});
});
