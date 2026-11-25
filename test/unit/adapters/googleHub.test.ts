/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { hubCommand, startHub } from '../../../src/adapters/googleHub';

vi.mock('node:child_process', async importOriginal => ({
	...await importOriginal<typeof cp>(),
	spawn: vi.fn(),
}));

const AGY = 'C:\\Users\\me\\.acp-hub\\agents\\google\\v1.5.3\\agy.exe';
const ARGS = ['--hub', '--hub-port=5000', '--csrf_token=t', '--app_data_dir=antigravity-copilot', '--add-dir=C:\\Temp'];

describe('starting the Antigravity hub', () => {
	it('enables hub mode so the CLI starts its server instead of its interactive UI', async () => {
		const server = net.createServer(socket => socket.end());
		vi.stubEnv('AGY_ENABLE_HUB', '0');
		vi.mocked(cp.spawn).mockImplementationOnce((_command, args, options) => {
			expect(options?.env?.AGY_ENABLE_HUB).toBe('1');
			const port = args?.join(' ').match(/--hub-port=(\d+)/)?.[1];
			if (!port) {
				throw new Error('Missing hub port');
			}
			server.listen(Number(port), '127.0.0.1');
			return new cp.ChildProcess();
		});
		try {
			const hub = await startHub(AGY, process.cwd());
			expect(hub.port).toBe((server.address() as net.AddressInfo).port);
			expect(cp.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
				env: expect.objectContaining({ AGY_ENABLE_HUB: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1' }),
			}));
			await hub.stop();
		} finally {
			server.close();
			vi.unstubAllEnvs();
			vi.mocked(cp.spawn).mockReset();
		}
	});
});

describe('the command that starts the Antigravity hub', () => {
	it('runs the CLI behind cmd.exe on Windows, so it inherits cmd\'s hidden console', () => {
		// A CLI started with no console of its own allocates one, and Windows hands it to the default
		// terminal as a window that flashes; one started by a hidden cmd inherits cmd's console instead.
		const command = hubCommand(AGY, ARGS, 'win32');
		expect(command.command).toBe('cmd.exe');
		expect(command.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
		expect(command.verbatim).toBe(true);
		// cmd strips the outer quotes and keeps the program quoted, so a folder with a space still runs.
		expect(command.args[3]).toBe(`""${AGY}" ${ARGS.join(' ')}"`);
	});

	it('quotes an argument with a space in it for cmd', () => {
		const spaced = 'C:\\Users\\me\\AppData\\Local\\Temp\\a folder';
		expect(hubCommand(AGY, ['--add-dir=' + spaced], 'win32').args[3]).toBe(`""${AGY}" "--add-dir=${spaced}""`);
	});

	it('runs the CLI directly where there is no console to inherit', () => {
		expect(hubCommand('/opt/agy', ARGS, 'linux')).toEqual({ command: '/opt/agy', args: ARGS });
		expect(hubCommand('/opt/agy', ARGS, 'darwin')).toEqual({ command: '/opt/agy', args: ARGS });
	});
});
