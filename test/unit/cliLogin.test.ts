import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { startCliLogin } from '../../src/core/cliLogin';

/** A login program that prints what the test says and records what is written to it. */
function fakeProgram() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		exitCode: null as number | null,
		kill() { child.exitCode = 1; child.emit('close', null); },
	});
	const written: string[] = [];
	child.stdin.on('data', chunk => written.push(chunk.toString()));
	const spawn = (() => child) as never;
	const exit = (code: number) => { child.exitCode = code; child.emit('close', code); };
	return { child, spawn, written, exit };
}

const PRINTED = 'Opening browser to sign in…\nIf the browser did not open, visit: https://claude.com/cai/oauth/authorize?state=abc\nPaste code here if prompted > ';

describe('startCliLogin', () => {
	it('finds the printed page, writes the pasted code and succeeds when the program exits cleanly', async () => {
		const { child, spawn, written, exit } = fakeProgram();
		const login = startCliLogin({ command: 'node', args: ['x'], env: {}, spawn });

		child.stdout.write(PRINTED);
		expect(await login.url).toBe('https://claude.com/cai/oauth/authorize?state=abc');
		expect(login.submitCode(' the-code#state \n')).toBe(true);
		await new Promise(resolve => setImmediate(resolve));
		expect(written).toEqual(['the-code#state\n']);

		exit(0);
		expect(await login.done).toEqual({ ok: true });
	});

	it('takes a page printed in two reads only once it is complete', async () => {
		const { child, spawn } = fakeProgram();
		const login = startCliLogin({ command: 'node', args: [], env: {}, spawn });

		child.stdout.write('visit: https://example.com/oauth?sta');
		child.stdout.write('te=abc\n');
		expect(await login.url).toBe('https://example.com/oauth?state=abc');
	});

	it('refuses a code that is empty, has a line break inside, or arrives before the page', async () => {
		const { child, spawn } = fakeProgram();
		const login = startCliLogin({ command: 'node', args: [], env: {}, spawn });

		expect(login.submitCode('early')).toBe(false);
		child.stdout.write(PRINTED);
		await login.url;
		expect(login.submitCode('  ')).toBe(false);
		expect(login.submitCode('one\ntwo')).toBe(false);
	});

	it('fails with the last line the program wrote to stderr', async () => {
		const { child, spawn, exit } = fakeProgram();
		const login = startCliLogin({ command: 'node', args: [], env: {}, spawn });

		child.stdout.write(PRINTED);
		await login.url;
		child.stderr.write('Login failed: Request failed with status code 400\n');
		await new Promise(resolve => setImmediate(resolve));
		exit(1);
		expect(await login.done).toEqual({ ok: false, message: 'Login failed: Request failed with status code 400' });
		expect(login.submitCode('late')).toBe(false);
	});

	it('reports no page when the program prints none in time', async () => {
		const { spawn } = fakeProgram();
		const login = startCliLogin({ command: 'node', args: [], env: {}, spawn, urlTimeoutMs: 10 });

		expect(await login.url).toBeUndefined();
		expect((await login.done).ok).toBe(false);
	});

	it('counts the login as done when the credentials appear although the program stays open', async () => {
		const { child, spawn } = fakeProgram();
		let written = false;
		const login = startCliLogin({ command: 'node', args: [], env: {}, spawn, completed: () => written });

		child.stdout.write(PRINTED);
		await login.url;
		written = true;
		expect(await login.done).toEqual({ ok: true });
	});

	it('is cancelled by cancel()', async () => {
		const { child, spawn } = fakeProgram();
		const login = startCliLogin({ command: 'node', args: [], env: {}, spawn });

		child.stdout.write(PRINTED);
		await login.url;
		login.cancel();
		expect((await login.done).ok).toBe(false);
	});
});
