/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SERVER_PORT, serverPortOf, type FileConfig } from '../hosts/http/config';
import type { ServerSurface } from '../ui/messages';

export interface ServerSurfaceDeps {
	readonly config: FileConfig;
	readonly token: string;
	readonly env: NodeJS.ProcessEnv;
	/** The port the server listens on now, known once it is bound. */
	readonly port: () => number;
	/** Closes the server and its agents, as a stop signal does. */
	readonly stop: () => void;
}

/** What the control page shows of this server, and the two things it may change: the saved port, and a restart. */
export function createServerSurface(deps: ServerSurfaceDeps): ServerSurface {
	return {
		view() {
			const port = deps.port();
			return {
				port,
				savedPort: serverPortOf(deps.config),
				url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(deps.token)}`,
				portFromEnv: Boolean(deps.env.ACP_HUB_PORT?.trim()),
				alive: true,
			};
		},
		setPort: port => deps.config.set(SERVER_PORT, port),
		restart: deps.stop,
	};
}
