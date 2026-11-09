import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, LaunchContext } from '../../../src/core/adapter';
import { AgentClient } from '../../../src/engine/acp/agentClient';
import type { Log } from '../../../src/engine/ports/host';

const ENGINE_ROOT = 'src/engine';

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (entry.name.endsWith('.ts')) {
			files.push(path);
		}
	}
	return files;
}

/**
 * The engine is the code both hosts share, so it may not reach for the VS Code
 * API; everything it needs comes through a port the host implements.
 */
export function assertEngineIsHostFree(root = ENGINE_ROOT): void {
	expect(existsSync(root), `${root} exists`).toBe(true);
	const sources = sourceFiles(root);
	expect(sources.length, `${root} has source files`).toBeGreaterThan(0);
	for (const file of sources) {
		expect(readFileSync(file, 'utf8'), `${file} imports vscode`).not.toMatch(/from 'vscode'/);
	}
}

describe('engine boundaries', () => {
	it('exists and never reaches for the VS Code API', () => {
		assertEngineIsHostFree();
	});

	/** The chat modules that live in the engine; each keeps a shim at its old path. */
	for (const name of ['cache', 'sessionStore', 'sessionFingerprint', 'usage', 'systemPrompt']) {
		it(`holds ${name}.ts without reaching for a host`, () => {
			expect(existsSync(`src/engine/chat/${name}.ts`), `src/engine/chat/${name}.ts exists`).toBe(true);
			assertEngineIsHostFree();
		});
	}

	it('constructs the ACP client without a host in scope', () => {
		expect(existsSync('src/engine/acp/agentClient.ts'), 'the ACP client lives in the engine').toBe(true);

		const adapter: AgentAdapter = {
			id: 'fake',
			displayName: 'Fake',
			vendor: 'acphub-fake',
			install: { kind: 'existing-cli', command: 'fake' },
			launch: () => ({ command: 'fake', args: [], env: {} }),
			auth: [],
			settings: [],
			modelPolicy: {} as AgentAdapter['modelPolicy'],
			systemPrompt: { toolAccess: '', listRequiredArguments: false },
		};
		const ctx: LaunchContext = { entryPath: 'fake', installDir: '', storageDir: '', settings: {}, workspaceFolder: '' };
		const log: Log = () => { };

		const client = new AgentClient(adapter, ctx, { log, storageDir: '', clientVersion: '0.0.0' });

		expect(client.isRunning).toBe(false);
		client.dispose();
	});
});
