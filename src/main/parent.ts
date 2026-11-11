/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stops a server when the process that started it goes away. Its stdin is a
 * pipe held by that process, and a closed pipe is what a killed parent looks
 * like on every platform, Windows included, where no signal arrives.
 */
export function exitWithParent(stdin: NodeJS.ReadableStream, stop: () => void): void {
	let stopped = false;
	const once = (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		stop();
	};
	stdin.on('end', once);
	stdin.on('close', once);
	stdin.on('error', once);
}
