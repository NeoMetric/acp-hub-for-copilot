/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentCardState, ControlState } from '../ui/messages';

/** Whether the account switch of the entry's type allows it: a type's own switch, or the one on the type an account belongs to. */
function typeSwitchOn(state: ControlState, agent: AgentCardState): boolean {
	const type = agent.accountOf === undefined ? agent : state.agents.find(entry => entry.id === agent.accountOf);
	return type?.accountsEnabled !== false;
}

/** What a card says about whether its agent's models may be offered, in one comparable string. */
function factsOf(state: ControlState, agent: AgentCardState): string {
	return [agent.install, agent.enabled, agent.signedIn, agent.hasSavedKey, typeSwitchOn(state, agent)].join('|');
}

/** Whether the picker may offer the models of the entry: it exists, is installed and on, and its type's account switch is not off. */
export function offeredIn(state: ControlState, agentId: string): boolean {
	const agent = state.agents.find(entry => entry.id === agentId);
	if (!agent) {
		return false;
	}
	return agent.install === 'installed' && agent.enabled && typeSwitchOn(state, agent);
}

/**
 * The agents whose card changed in a way that changes the models a window may
 * offer: an install or an uninstall, being switched on or off, a sign-in, or a
 * saved key. An agent the state did not hold before counts as changed too.
 *
 * Nothing here names an agent; the server's state says which ones it holds.
 */
export function changedAgents(previous: ControlState | undefined, next: ControlState): string[] {
	const before = new Map<string, string>();
	if (previous) {
		for (const agent of previous.agents) {
			before.set(agent.id, factsOf(previous, agent));
		}
	}
	return next.agents.filter(agent => before.get(agent.id) !== factsOf(next, agent)).map(agent => agent.id);
}
