/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { nativeSessionPolicy } from '../core/nativeSessionPolicy';
import type { SessionPolicy } from '../core/sessionPolicy';

/**
 * `agy acp` cannot fork a session, so its CLI's language server copies the conversation instead: a fork
 * always goes through the adapter's forker, even if the agent advertised a fork of its own. Rewinding the
 * source needs the agent to read it afresh, which one process does only on a restart; and the agent applies
 * the prompt of each request whenever it opens a session, so a rebuilt prompt misses the cache.
 */
export const googleSessionPolicy: SessionPolicy = {
	...nativeSessionPolicy,
	planContinuation: ({ saved, live, editedOwnChat, externalForker }) => {
		if (!externalForker) {
			return { how: 'rebuild' };
		}
		// Rewinding the source only helps if the agent reads it again, which takes a restart; a restart
		// would end the turn of another chat, so then the fork takes an id of its own instead.
		const busy = live.filter(session => session.hasTurn && session.sessionId !== saved.sessionId);
		const keepSourceId = editedOwnChat && busy.length === 0;
		return { how: 'fork-external', keepSourceId, restartFirst: keepSourceId };
	},
	canFork: () => true,
	promptForOpen: ({ savedPrompt, rebuilt }) => savedPrompt || rebuilt,
	keepsSavedPrompt: true,
};
