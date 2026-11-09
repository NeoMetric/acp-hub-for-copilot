/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAdapter } from '../adapter';
import { nativeSessionPolicy } from '../nativeSessionPolicy';
import type { SessionPolicy } from '../sessionPolicy';

/**
 * The policy an adapter's flags describe, for an adapter that declares none of its own: the decisions
 * the provider used to make from `forkChats`, `restartAfterFork`, `keepsSessionPrompt` and
 * `refreshesTools`, kept in one place while the last adapter still sets them. It goes with the flags.
 */
export function flagSessionPolicy(adapter: AgentAdapter): SessionPolicy {
	const forksChats = adapter.forkChats === true;
	return {
		...nativeSessionPolicy,
		planContinuation: ({ saved, live, editedOwnChat, agentSupportsFork, externalForker }) => {
			if (agentSupportsFork && forksChats) {
				return { how: 'fork-native' };
			}
			if (!externalForker) {
				return { how: 'rebuild' };
			}
			// Rewinding the source only helps if the agent reads it again, which a restart would be
			// needed for; a restart would end the turn of another chat, so then the fork takes an id
			// of its own instead.
			const busy = live.filter(session => session.hasTurn && session.sessionId !== saved.sessionId);
			const keepSourceId = editedOwnChat && busy.length === 0;
			return { how: 'fork-external', keepSourceId, restartFirst: keepSourceId && adapter.restartAfterFork === true };
		},
		promptForOpen: ({ savedPrompt, rebuilt }) => adapter.keepsSessionPrompt === true ? savedPrompt || rebuilt : rebuilt,
		keepsSavedPrompt: adapter.keepsSessionPrompt === true,
		toolsChangedAction: () => adapter.refreshesTools === true ? 'list-changed' : 'reopen',
		toolWaitMs: settings => typeof adapter.toolWaitTimeoutMs === 'number' && Number.isFinite(adapter.toolWaitTimeoutMs) && adapter.toolWaitTimeoutMs > 0
			? adapter.toolWaitTimeoutMs
			: nativeSessionPolicy.toolWaitMs(settings),
	};
}
