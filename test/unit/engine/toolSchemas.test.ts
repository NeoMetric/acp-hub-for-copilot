import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { ToolSchemas } from '../../../src/engine/mcp/toolSchemas';

const dialects = [
	'http://json-schema.org/draft-07/schema#',
	'https://json-schema.org/draft/2019-09/schema',
	'https://json-schema.org/draft/2020-12/schema',
];

describe.each(dialects)('tool schema cache (%s)', dialect => {
	const schema = (n: number) => ({ $schema: dialect, type: 'object', properties: { n: { const: n } } });

	it('reuses validators for recreated schemas and reordered object keys', () => {
		const cache = new ToolSchemas(() => undefined);
		const original = schema(1);
		const validate = cache.validator(original);
		for (let i = 0; i < 200; i++) {
			expect(cache.validator(JSON.parse(JSON.stringify(original)))).toBe(validate);
		}
		expect(cache.validator({ properties: original.properties, type: 'object', $schema: dialect })).toBe(validate);
		expect(validate({ n: 1 })).toBe(true);
		expect(validate({ n: 2 })).toBe(false);
	});

	it('evicts the least recently used validator after 128 entries', () => {
		const cache = new ToolSchemas(() => undefined);
		const first = cache.validator(schema(0));
		const second = cache.validator(schema(1));
		for (let i = 2; i < 128; i++) {cache.validator(schema(i));}
		expect(cache.validator(schema(0))).toBe(first);
		cache.validator(schema(128));
		expect(cache.validator(schema(0))).toBe(first);
		const recreated = cache.validator(schema(1));
		expect(recreated).not.toBe(second);
		expect(recreated({ n: 1 })).toBe(true);
		expect(recreated({ n: 0 })).toBe(false);
	});

	it('bounds retained schema bytes and validates oversized schemas without caching them', () => {
		const cache = new ToolSchemas(() => undefined);
		const large = (n: number) => ({ ...schema(n), description: 'a'.repeat(3 * 1024 * 1024) });
		const first = cache.validator(large(0));
		cache.validator(large(1));
		cache.validator(large(2));
		expect(cache.validator(large(0))).not.toBe(first);
		const oversized = { ...schema(3), description: 'a'.repeat(8 * 1024 * 1024) };
		const validate = cache.validator(oversized);
		expect(validate({ n: 3 })).toBe(true);
		expect(validate({ n: 4 })).toBe(false);
		expect(cache.validator(oversized)).not.toBe(validate);
	});

	it('isolates reused nested identifiers and failed compilations', () => {
		const cache = new ToolSchemas(() => undefined);
		for (let i = 0; i < 4; i++) {
			const original = { $schema: dialect, $id: 'https://example.invalid/root', type: 'object', definitions: { local: { $id: 'child', type: 'integer', minimum: i } }, properties: { n: { $ref: 'child' } } };
			const validate = cache.validator(original);
			expect(validate({ n: i })).toBe(true);
			expect(validate({ n: i - 1 })).toBe(false);
			const invalid = { ...original, properties: { n: { $ref: 'missing' } } };
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(() => cache.validator(invalid)).toThrow();
			}
			expect(cache.validator(original)).toBe(validate);
		}
	});
});

it('allows evicted validators to be collected while the cache remains alive', async () => {
	const bundle = await build({
		entryPoints: [path.resolve(__dirname, '../../fixtures/tool-schema-gc.ts')],
		bundle: true, platform: 'node', format: 'cjs', write: false,
	});
	const directory = await mkdtemp(path.join(tmpdir(), 'acp-hub-schema-gc-'));
	try {
		const script = path.join(directory, 'probe.cjs');
		await writeFile(script, bundle.outputFiles[0].contents);
		const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', script], { timeout: 20_000 });
		expect(JSON.parse(stdout)).toEqual(dialects.map(dialect => ({ dialect, collected: true })));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
