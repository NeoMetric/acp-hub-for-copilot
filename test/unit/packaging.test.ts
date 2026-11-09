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
	it('builds the server beside the extension bundle, into dist', () => {
		const outfile = outfileOf(entryOf(readFileSync('esbuild.js', 'utf8'), 'src/main/server.ts'));
		expect(outfile).toBe('dist/server.js');
	});

	it('ships the server bundle, the page and the adapter manifests in the VSIX', () => {
		const ignored = ignoredPaths();
		// The server is no longer a program of its own that only a developer runs: every
		// window starts it, so it travels with the extension.
		for (const path of ['server-dist/**', 'dist/**', 'dist/server.js', 'dist/sidebar.js', 'media/**', 'media/sidebar.css', 'adapters/**', '**/*.js']) {
			expect(ignored, `${path} must not be ignored: the VSIX has to contain it`).not.toContain(path);
		}
	});

	it('excludes the sources, so the HTTP host ships only as a bundle', () => {
		const ignored = ignoredPaths();
		expect(ignored).toContain('src/**');
		expect(ignored).toContain('**/*.ts');
		expect(ignored).toContain('test/**');
	});

	it('builds the page once, into the bundle the sidebar and the server both load', () => {
		const outfile = outfileOf(entryOf(readFileSync('esbuild.js', 'utf8'), 'src/ui/main.ts'));
		expect(outfile).toBe('dist/sidebar.js');
	});

	it('keeps the extension as the manifest entry point', () => {
		expect(packageJson.main).toBe('./dist/extension.js');
	});

	it('runs the server the VSIX ships with npm run server', () => {
		expect(packageJson.scripts.server).toBe('node dist/server.js');
	});
});
