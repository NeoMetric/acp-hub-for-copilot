/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionPolicy } from './sessionPolicy';

/**
 * The default way a stored conversation continues: the agent's own fork when it advertises one, else
 * the forker the adapter names, else a rebuild from the transcript. A fork is offered only when the
 * agent advertises one, always takes an id of its own and never restarts the agent; every open gets the
 * rebuilt prompt, a changed tool set needs a new session, and a tool call waits for as long as the agent does.
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
	canFork: ({ agentSupportsFork }) => agentSupportsFork,
	promptForOpen: ({ rebuilt }) => rebuilt,
	keepsSavedPrompt: false,
	toolsChangedAction: () => 'reopen',
	toolWaitMs: () => Number.POSITIVE_INFINITY,
};
