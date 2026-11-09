/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionPolicy } from './sessionPolicy';

/**
 * How Claude and Codex continue a stored conversation: the agent's own fork when it advertises one,
 * else the forker the adapter names, else a rebuild from the transcript. A fork there always takes
 * an id of its own and the agent is never restarted for it; every open gets the rebuilt prompt, a
 * changed tool set needs a new session, and a tool call waits as long as the agent does.
 */
export const nativeSessionPolicy: SessionPolicy = {
	planContinuation: ({ agentSupportsFork, externalForker }) => {
		if (agentSupportsFork) {
			return { how: 'fork-native' };
		}
		if (externalForker) {
			return { how: 'fork-external', keepSourceId: false, restartFirst: false };
		}
		return { how: 'rebuild' };
	},
	promptForOpen: ({ rebuilt }) => rebuilt,
	toolsChangedAction: () => 'reopen',
	toolWaitMs: ({ toolWaitTimeoutMs }) => typeof toolWaitTimeoutMs === 'number' && Number.isFinite(toolWaitTimeoutMs) && toolWaitTimeoutMs > 0
		? toolWaitTimeoutMs
		: Number.POSITIVE_INFINITY,
};
