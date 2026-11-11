import { describe, expect, it } from 'vitest';
import { parseServerLine, withScope, type LogLevel } from '../../src/core/logging';

describe('parseServerLine', () => {
	it('takes the time and the level off a line the server formatted', () => {
		expect(parseServerLine('2026-11-10T05:23:02.478Z INFO [claude] Created chat session')).toEqual({ level: 'info', message: '[claude] Created chat session' });
		expect(parseServerLine('2026-11-10T05:23:02.478Z WARN [codex] slow')).toEqual({ level: 'warn', message: '[codex] slow' });
		expect(parseServerLine('2026-11-10T05:23:02.478Z ERROR boom')).toEqual({ level: 'error', message: 'boom' });
		expect(parseServerLine('2026-11-10T05:23:02.478Z DEBUG detail')).toEqual({ level: 'debug', message: 'detail' });
	});

	it('leaves a line the server did not format whole', () => {
		expect(parseServerLine('Error: listen EADDRINUSE')).toEqual({ level: 'info', message: 'Error: listen EADDRINUSE' });
	});
});

describe('withScope', () => {
	it('prefixes the message with the scope and keeps the level', () => {
		const seen: Array<[string, LogLevel | undefined]> = [];
		withScope((message, level) => seen.push([message, level]), 'claude')('hello', 'warn');
		expect(seen).toEqual([['[claude] hello', 'warn']]);
	});
});
