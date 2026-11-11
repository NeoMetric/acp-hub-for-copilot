/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare const __ACP_HUB_VERSION__: string | undefined;

/** The version this bundle was built from, so a path can name the folder the installed extension is in. */
const VERSION = typeof __ACP_HUB_VERSION__ === 'undefined' ? 'dev' : __ACP_HUB_VERSION__;

/** The server script inside a VS Code install, below the extensions folder the editor keeps. */
const SERVER_SCRIPT = `neometric.acp-hub-for-copilot-${VERSION}/dist/server.js`;

/** The command that runs the server with no window open, in PowerShell on Windows. */
export const SERVER_COMMAND = `node "$env:USERPROFILE\\.vscode\\extensions\\neometric.acp-hub-for-copilot-${VERSION}\\dist\\server.js"`;

/** The same script the way macOS and Linux spell its path. */
export const SERVER_SCRIPT_POSIX = `~/.vscode/extensions/${SERVER_SCRIPT}`;
