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

	/**
	 * How Copilot marks up a chat is the VS Code host's business: the engine sees
	 * neutral messages, and the host that scraped the prompt hands it the chat's
	 * identity and guidance.
	 *
	 * The names are matched wherever they appear, not only between angle brackets:
	 * a section spelled inside an alternation, as in `(environment_info|...)`, is
	 * the same host knowledge as a literal `<workspace_info>`, and so is a bare
	 * name in a comment or a regular expression.
	 */
	it('knows nothing of Copilot\'s prompt format, which lives in the VS Code host', () => {
		expect(existsSync('src/hosts/vscode/identity.ts'), 'the scrapers live in the VS Code host').toBe(true);
		const hostKnowledge = /environment_info|workspace_info|userMemory|sessionMemory|repoMemory|_conversationId|<environment_context>/;
		for (const file of sourceFiles(ENGINE_ROOT)) {
			expect(readFileSync(file, 'utf8'), `${file} names a block only Copilot's prompt has`).not.toMatch(hostKnowledge);
		}
		expect(readFileSync('src/hosts/vscode/identity.ts', 'utf8'), 'the VS Code host keeps the sections it strips')
			.toMatch(/environment_info[\s\S]*workspace_info[\s\S]*userMemory[\s\S]*sessionMemory[\s\S]*repoMemory/);
		expect(readFileSync('src/core/provider.ts', 'utf8'), 'the provider no longer reads the conversation id').not.toContain('_conversationId');
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
