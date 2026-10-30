/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run by VS Code (`vscode:uninstall`) after the extension is uninstalled, on the next start. It has
// no access to the VS Code API and a few seconds to finish, so it only deletes the downloaded agents.
import * as path from 'node:path';
import { removeRecordedStorage } from './core/storageCleanup';

removeRecordedStorage(path.resolve(__dirname, '..'), 'neometric.acp-hub-for-copilot');
