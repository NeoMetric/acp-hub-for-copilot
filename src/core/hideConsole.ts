/**
 * On Windows the extension host is a GUI process, so the Node child it spawns has no
 * console to hand on, and every console program that child starts (the agent binary)
 * opens a visible terminal window. A preload that defaults `windowsHide` for the
 * child's own spawns closes that gap without touching the adapter.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PRELOAD = `'use strict';
const cp = require('node:child_process');
const { promisify } = require('node:util');
const hidden = (args) => {
	const index = args.findIndex((arg, at) => at > 0 && arg && typeof arg === 'object' && !Array.isArray(arg));
	if (index >= 0) {
		args[index] = { windowsHide: true, ...args[index] };
	} else if (typeof args[args.length - 1] === 'function') {
		args.splice(args.length - 1, 0, { windowsHide: true });
	} else {
		args.push({ windowsHide: true });
	}
	return args;
};
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
	const original = cp[name];
	const wrapped = function (...args) {
		return original.apply(this, hidden(args));
	};
	// promisify(execFile) resolves to { stdout, stderr } only through this symbol; without it the
	// agent gets the bare stdout string and reads every command's output as missing.
	const custom = original[promisify.custom];
	if (custom) {
		wrapped[promisify.custom] = function (...args) {
			return custom.apply(this, hidden(args));
		};
	}
	cp[name] = wrapped;
}
`;

/**
 * The `NODE_OPTIONS` value that loads the preload, or `existing` unchanged off Windows or when
 * the file cannot be written. An environment option, not a flag: the adapter's entry point is a
 * launcher that starts the real adapter as a second Node process, and only that one runs the agent.
 */
export function hideConsoleNodeOptions(directory: string, existing?: string): string | undefined {
	if (process.platform !== 'win32') {
		return existing;
	}
	const file = join(directory, 'hide-console.cjs');
	try {
		let current: string | undefined;
		try {
			current = readFileSync(file, 'utf8');
		} catch {
			current = undefined;
		}
		if (current !== PRELOAD) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(file, PRELOAD);
		}
		return [existing, `--require "${file.replace(/\\/g, '/')}"`].filter(Boolean).join(' ');
	} catch {
		return existing;
	}
}
