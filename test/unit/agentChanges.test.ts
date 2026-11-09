import { describe, expect, it } from 'vitest';
import type { AgentCardState, ControlState } from '../../src/ui/messages';
import { changedAgents } from '../../src/sidebar/agentChanges';

function card(overrides: Partial<AgentCardState> = {}): AgentCardState {
	return {
		id: 'one',
		displayName: 'One',
		install: 'installed',
		removable: true,
		signedIn: 'yes',
		hasSavedKey: false,
		enabled: true,
		visible: true,
		settings: [],
		usage: { status: 'idle', windows: [] },
		...overrides,
	};
}

const stateOf = (...agents: AgentCardState[]): ControlState => ({ agents });

describe('the agents whose card changed what the picker may offer', () => {
	it('a first state counts every agent it holds as changed', () => {
		expect(changedAgents(undefined, stateOf(card({ id: 'one' }), card({ id: 'two' })))).toEqual(['one', 'two']);
	});

	it('nothing changed between two identical snapshots', () => {
		const state = stateOf(card(), card({ id: 'two' }));

		expect(changedAgents(state, stateOf(card(), card({ id: 'two' })))).toEqual([]);
	});

	it('an install, an enable, a sign-in or a saved key each count', () => {
		const before = stateOf(card(), card({ id: 'two' }), card({ id: 'three' }), card({ id: 'four' }));

		expect(changedAgents(before, stateOf(
			card({ install: 'not-installed' }),
			card({ id: 'two', enabled: false }),
			card({ id: 'three', signedIn: 'no' }),
			card({ id: 'four', hasSavedKey: true }),
		))).toEqual(['one', 'two', 'three', 'four']);
	});

	it('an agent the state adds counts, and one that leaves does not', () => {
		const before = stateOf(card({ id: 'one' }));

		expect(changedAgents(before, stateOf(card({ id: 'two' })))).toEqual(['two']);
	});

	it('a busy line or a usage figure alone does not count', () => {
		const before = stateOf(card());

		const after = stateOf(card({ busy: 'Installing...', usage: { status: 'ok', windows: [] }, visible: false }));

		expect(changedAgents(before, after)).toEqual([]);
	});
});
