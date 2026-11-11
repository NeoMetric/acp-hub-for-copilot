/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { ToolCallParking } from '../../src/hosts/http/host';

const NO_LOG = (): void => undefined;
const CALL = { callId: 'call-1', name: 'ask_user' };
const UNBOUNDED = Number.POSITIVE_INFINITY;
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('ToolCallParking', () => {
	it('holds a call with an unbounded wait until its result comes', async () => {
		const parking = new ToolCallParking(undefined, NO_LOG);
		const fail = vi.fn();

		parking.park('chat', CALL, fail, UNBOUNDED);
		await wait(50);

		expect(fail).not.toHaveBeenCalled();
		expect(parking.has('chat', CALL.callId)).toBe(true);
		expect(parking.take('chat', CALL.callId)).toBe(true);
	});

	it('fails a call its client never answers within the wait it was given', async () => {
		const parking = new ToolCallParking(undefined, NO_LOG);
		const fail = vi.fn();

		parking.park('chat', CALL, fail, 20);
		await wait(80);

		expect(fail).toHaveBeenCalledTimes(1);
		expect(parking.has('chat', CALL.callId)).toBe(false);
	});

	it('replaces the wait of every call with the one the server was given', async () => {
		const parking = new ToolCallParking(20, NO_LOG);

		parking.park('chat', CALL, vi.fn(), UNBOUNDED);
		await wait(80);

		expect(parking.has('chat', CALL.callId)).toBe(false);
	});

	it('names the chat that holds a call, so another chat cannot settle it', () => {
		const parking = new ToolCallParking(undefined, NO_LOG);

		parking.park('chat-a', CALL, NO_LOG, UNBOUNDED);

		expect(parking.heldElsewhere('chat-b', CALL.callId)).toBe(true);
		expect(parking.heldElsewhere('chat-a', CALL.callId)).toBe(false);
	});
});
