import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../src/core/agents';

const AGENT_LITERAL = /['"`](claude|codex|google)['"`]/;
const VENDOR_COMPARE = /===\s*['"](Claude|Codex|Google) Agent/;

function tsFilesUnder(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...tsFilesUnder(path));
		} else if (entry.name.endsWith('.ts')) {
			files.push(path);
		}
	}
	return files;
}

describe('core stays agent-neutral', () => {
	for (const dir of ['src/core', 'src/sidebar']) {
		it(`${dir} never names an agent`, () => {
			if (!existsSync(dir)) {
				return;
			}
			for (const file of tsFilesUnder(dir)) {
				const text = readFileSync(file, 'utf8');
				expect(AGENT_LITERAL.test(text), `${file} names an agent`).toBe(false);
				expect(VENDOR_COMPARE.test(text), `${file} compares a vendor id`).toBe(false);
			}
		});
	}

	it('findAdapter returns undefined for an unknown id', () => {
		expect(findAdapter('nope')).toBeUndefined();
	});
});
