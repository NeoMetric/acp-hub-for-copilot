/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { hubCommand } from '../../../src/adapters/googleHub';

const AGY = 'C:\\Users\\me\\.acp-hub\\agents\\google\\v1.5.3\\agy.exe';
const ARGS = ['--hub', '--hub-port=5000', '--csrf_token=t', '--app_data_dir=antigravity-copilot', '--add-dir=C:\\Temp'];

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
