import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseModelCatalog, readModelCatalog } from '../../../src/adapters/codexModelCatalog';

describe('the Codex model catalog', () => {
	it('reduces each window by the effective percentage', () => {
		const windows = parseModelCatalog({
			models: [
				{ slug: 'gpt-6.1-sol', context_window: 500_000, max_context_window: 872_000, effective_context_window_percent: 95 },
				{ slug: 'gpt-6-luna', context_window: 272_000, max_context_window: 272_000 },
			],
		});

		expect(windows.get('gpt-6.1-sol')).toEqual({ normal: 475_000, max: 828_400 });
		// No percentage listed: Codex's own 95% applies.
		expect(windows.get('gpt-6-luna')).toEqual({ normal: 258_400, max: 258_400 });
	});

	it('skips entries without a usable window and never lets the maximum fall below the default', () => {
		const windows = parseModelCatalog({
			models: [{ slug: 'no-window' }, { context_window: 100 }, { slug: 'odd', context_window: 100_000, max_context_window: 10 }],
		});

		expect([...windows.keys()]).toEqual(['odd']);
		expect(windows.get('odd')).toEqual({ normal: 95_000, max: 95_000 });
	});

	it('is empty for a missing or unreadable file', () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
		try {
			expect(readModelCatalog(folder).size).toBe(0);
			fs.writeFileSync(path.join(folder, 'models_cache.json'), '{not json');
			expect(readModelCatalog(folder).size).toBe(0);
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
		}
	});
});
