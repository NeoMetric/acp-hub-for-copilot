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
	writeManagedConfig(path.join(home, 'config.toml'));
	return home;
}

const MANAGED_MARKER = '# Managed by ACP Hub. Delete this line to keep your own edits.';

/**
 * Codex gives up on a call to an MCP server after 300 seconds, and a call to the bridge
 * waits for Copilot to run the tool, which for a question is as long as the user takes
 * to answer. The adapter hands the bridge to a session with only its address and token,
 * with no way to set a timeout, so the timeout is set here and Codex merges it in. The
 * limit exists only to bound a call that is lost, as it does for Claude.
 *
 * Codex checks this file on its own before it reads a session's servers, and refuses an
 * entry that names no transport, so the entry carries an address that nothing listens on.
 * The session's own address and token replace it.
 */
const MANAGED_CONFIG = `${MANAGED_MARKER}
[mcp_servers.vscode]
url = "http://127.0.0.1:9/"
tool_timeout_sec = ${24 * 60 * 60}
`;

/** Writes the config unless the file is one the user took over by removing the marker line. */
function writeManagedConfig(file: string): void {
	let current: string | undefined;
	try {
		current = fs.readFileSync(file, 'utf8');
	} catch {
		current = undefined;
	}
	if (current === MANAGED_CONFIG || (current !== undefined && !current.startsWith(MANAGED_MARKER))) {
		return;
	}
	fs.writeFileSync(file, MANAGED_CONFIG);
}
