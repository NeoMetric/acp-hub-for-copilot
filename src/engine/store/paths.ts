/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';

/** The variable both gateways read to move the store they share. */
export const STORAGE_ROOT_ENV = 'ACP_HUB_HOME';

/**
 * The folder both gateways keep their data in: `ACP_HUB_HOME` when it names
 * one, else `~/.acp-hub`. One folder for both hosts is what lets a chat saved
 * in one gateway resume in the other, so neither host invents a path.
 */
export function storageRoot(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[STORAGE_ROOT_ENV]?.trim();
	return path.resolve(configured ? configured : path.join(os.homedir(), '.acp-hub'));
}

/**
 * The folder the agents are installed in, below the store root both gateways
 * share. Both derive it from the root, so an agent installed by one gateway is
 * the install the other launches, with the same logs and pid registry.
 */
export function agentsRoot(root: string): string {
	return path.join(path.resolve(root), 'agents');
}

/**
 * The folder the token usage of finished turns is kept in, below the store
 * root. A server writes it, and the page reads it; it settles nowhere else.
 */
export function usageRoot(root: string): string {
	return path.join(path.resolve(root), 'usage');
}
