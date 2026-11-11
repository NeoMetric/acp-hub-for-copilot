import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedAdapterCoreImports } from './support/boundaries';

function adapters(): string[] {
	return readdirSync('src/adapters').filter(name => name.endsWith('.ts')).map(name => join('src/adapters', name));
}

describe('adapter boundaries', () => {
	it('adapters import core only through the declared surface', () => {
		for (const file of adapters()) {
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(/from '\.\.\/core\/([^']+)'/g)) {
				const module = match[1].replace(/\.ts$/, '');
				expect(allowedAdapterCoreImports, `${file} imports core/${module}`).toContain(module);
			}
		}
	});

	it('adapters do not import vscode', () => {
		for (const file of adapters()) {
			expect(readFileSync(file, 'utf8')).not.toMatch(/from 'vscode'/);
		}
	});
});
