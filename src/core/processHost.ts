/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';

/** How long a POSIX process group gets to exit after SIGTERM before it is killed. */
const TERMINATE_GRACE_MS = 3_000;

/**
 * Every spawned agent process, so `deactivate` can take down processes that
 * outlived their owner.
 */
export const children = new Set<number>();

export function trackChild(pid: number): void {
	children.add(pid);
}

/**
 * Kills a process and everything it spawned.
 *
 * On Windows a process tree can only be taken down with `taskkill /T`; on POSIX
 * the child is spawned as a process-group leader (`detached`), so signalling
 * the negated pid reaches its descendants too. The pid stays tracked until the
 * kill has finished, so a `deactivate` that races with it still cleans up.
 */
export async function killTree(pid: number): Promise<void> {
	if (process.platform === 'win32') {
		await run('taskkill', ['/pid', String(pid), '/T', '/F']);
		children.delete(pid);
		return;
	}

	signalGroup(pid, 'SIGTERM');
	const deadline = Date.now() + TERMINATE_GRACE_MS;
	while (isAlive(pid) && Date.now() < deadline) {
		await new Promise<void>(resolve => setTimeout(resolve, 100));
	}
	if (isAlive(pid)) {
		signalGroup(pid, 'SIGKILL');
	}
	children.delete(pid);
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function run(file: string, args: readonly string[]): Promise<void> {
	return new Promise(resolve => {
		const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
		child.on('error', () => resolve());
		child.on('exit', () => resolve());
	});
}
