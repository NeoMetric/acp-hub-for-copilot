import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { idleMsOf, watchIdle } from '../../src/main/idle';

/** A server that only emits the `request` event, with a response whose end the test controls. */
function fakeServer(): { server: Server; request: () => EventEmitter } {
	const server = new EventEmitter();
	return {
		server: server as unknown as Server,
		request: () => {
			const response = new EventEmitter();
			server.emit('request', {}, response);
			return response;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('watchIdle', () => {
	it('stops a server nobody has asked anything for the whole limit', () => {
		vi.useFakeTimers();
		const { server } = fakeServer();
		const onIdle = vi.fn();
		watchIdle(server, { idleMs: 60_000, onIdle, intervalMs: 10_000 });

		vi.advanceTimersByTime(50_000);
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10_000);
		expect(onIdle).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(120_000);
		expect(onIdle, 'it stops once').toHaveBeenCalledTimes(1);
	});

	it('counts every request as use and waits out one still being answered', () => {
		vi.useFakeTimers();
		const { server, request } = fakeServer();
		const onIdle = vi.fn();
		watchIdle(server, { idleMs: 60_000, onIdle, intervalMs: 10_000 });

		vi.advanceTimersByTime(50_000);
		const response = request();
		vi.advanceTimersByTime(300_000);
		expect(onIdle, 'a request that never ended keeps the server up').not.toHaveBeenCalled();

		response.emit('close');
		vi.advanceTimersByTime(50_000);
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10_000);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});
});

describe('idleMsOf', () => {
	it('reads minutes, and treats anything that is not a positive number as never', () => {
		expect(idleMsOf('30')).toBe(1_800_000);
		expect(idleMsOf(' 0.5 ')).toBe(30_000);
		expect(idleMsOf('0')).toBe(0);
		expect(idleMsOf('-4')).toBe(0);
		expect(idleMsOf('soon')).toBe(0);
		expect(idleMsOf(undefined)).toBe(0);
	});
});
