/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { exitWithParent } from '../../src/main/parent';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe('exitWithParent', () => {
	it('calls stop when stdin ends', async () => {
		const stdin = new PassThrough();
		let stops = 0;
		const stopped = new Promise<void>(resolve => exitWithParent(stdin, () => {
			stops++;
			resolve();
		}));

		// The server resumes its stdin, so a closed pipe is read to its end.
		stdin.resume();
		stdin.end();
		await stopped;
		await delay(50);

		expect(stops).toBe(1);
	});

	it('calls stop when the pipe is destroyed, as a killed parent leaves it', async () => {
		const stdin = new PassThrough();
		let stops = 0;
		const stopped = new Promise<void>(resolve => exitWithParent(stdin, () => {
			stops++;
			resolve();
		}));

		stdin.destroy();
		await stopped;
		await delay(50);

		expect(stops).toBe(1);
	});

	it('does nothing while stdin stays open', async () => {
		const stdin = new PassThrough();
		let stops = 0;
		exitWithParent(stdin, () => { stops++; });

		await delay(100);

		expect(stops).toBe(0);
		stdin.end();
	});
});
