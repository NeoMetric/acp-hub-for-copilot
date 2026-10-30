/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The folder Codex runs in as `CODEX_HOME`. The user's own `~/.codex` carries the MCP
 * servers and plugins of their Codex app, and the adapter replaces `mcp_servers` in the
 * session config with the bridge alone, so nothing inherited from there can be switched
 * off. A folder of the extension's own never has any of it. It also holds the ChatGPT
 * sign-in the extension makes, apart from the one the Codex app uses.
 */
export function ensureCodexHome(globalStoragePath: string): string {
	const home = path.join(globalStoragePath, 'codex-home');
	fs.mkdirSync(home, { recursive: true });
	return home;
}
