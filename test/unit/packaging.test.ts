import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

function ignoredPaths(): string[] {
	return readFileSync('.vscodeignore', 'utf8').split(/\r?\n/).map(line => line.trim());
}

/**
 * The esbuild entry object that builds `entry`, taken from the source text:
 * the script starts a build when it is imported, so it cannot be read as a module.
 */
function entryOf(source: string, entry: string): string {
	const at = source.indexOf(entry);
	expect(at, `esbuild.js should name ${entry}`).toBeGreaterThanOrEqual(0);
	return source.slice(source.lastIndexOf('{', at), source.indexOf('}', at) + 1);
}

function outfileOf(entry: string): string {
	const match = /outfile:\s*(['"])([^'"]+)\1/.exec(entry);
	expect(match, `the entry should name an outfile: ${entry}`).not.toBeNull();
	return match![2];
}

describe('packaging', () => {
	it('excludes the server bundle from the VSIX', () => {
		expect(ignoredPaths()).toContain('server-dist/**');
	});

	it('excludes the sources, so the HTTP host cannot ship', () => {
		const ignored = ignoredPaths();
		expect(ignored).toContain('src/**');
		expect(ignored).toContain('**/*.ts');
	});

	it('builds the server into server-dist, away from the extension bundle', () => {
		const outfile = outfileOf(entryOf(readFileSync('esbuild.js', 'utf8'), 'src/main/server.ts'));
		expect(outfile.startsWith('server-dist/')).toBe(true);
		expect(outfile.startsWith('dist/')).toBe(false);
	});

	it('keeps the extension as the manifest entry point', () => {
		expect(packageJson.main).toBe('./dist/extension.js');
	});

	it('contributes nothing for the server', () => {
		expect(JSON.stringify(packageJson.contributes)).not.toMatch(/server/i);
	});
});
