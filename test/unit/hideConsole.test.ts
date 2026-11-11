import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hideConsoleNodeOptions } from '../../src/core/hideConsole';

describe.runIf(process.platform === 'win32')('hideConsoleNodeOptions', () => {
	it('keeps promisify(execFile) resolving to stdout and stderr', () => {
		const directory = mkdtempSync(join(tmpdir(), 'hide-console-'));
		try {
			const options = hideConsoleNodeOptions(directory)!;
			expect(readFileSync(join(directory, 'hide-console.cjs'), 'utf8')).toContain('promisify');
			const script = `const { promisify } = require('node:util');
				const { execFile } = require('node:child_process');
				promisify(execFile)(process.execPath, ['-p', '1+1']).then(result => console.log(JSON.stringify(result)));`;
			const output = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, NODE_OPTIONS: options }, encoding: 'utf8' });
			expect(JSON.parse(output)).toEqual({ stdout: '2\n', stderr: '' });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
