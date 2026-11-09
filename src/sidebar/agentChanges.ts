/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentCardState, ControlState } from '../ui/messages';

/** What a card says about whether its agent's models may be offered, in one comparable string. */
function factsOf(agent: AgentCardState): string {
	return [agent.install, agent.enabled, agent.signedIn, agent.hasSavedKey].join('|');
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
	for (const agent of previous?.agents ?? []) {
		before.set(agent.id, factsOf(agent));
	}
	return next.agents.filter(agent => before.get(agent.id) !== factsOf(agent)).map(agent => agent.id);
}
