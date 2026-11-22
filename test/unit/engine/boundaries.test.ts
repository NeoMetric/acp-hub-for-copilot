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
	 * The control service is what a browser page drives, so it takes the window
	 * as callbacks rather than reaching for it: a `vscode` import here would make
	 * the page depend on the editor it is meant to work without.
	 */
	it('drives the page from a control service that has no host in it', () => {
		expect(existsSync('src/engine/control/ControlService.ts'), 'the control service lives in the engine').toBe(true);
		expect(sourceFiles(join(ENGINE_ROOT, 'control')).length, 'src/engine/control has source files').toBeGreaterThan(0);
		assertEngineIsHostFree(join(ENGINE_ROOT, 'control'));
		for (const file of sourceFiles(join(ENGINE_ROOT, 'control'))) {
			expect(readFileSync(file, 'utf8'), `${file} reaches for the editor's window`).not.toMatch(/vscode\./);
		}
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
	});

	/**
	 * What reaches the model on the way to the agent names no client. Comments are skipped; the
	 * pattern is case-sensitive so `--vscode-*` CSS variables and the on-disk agent id stay.
	 */
	it('writes no client words into the prompt path', () => {
		const files = [
			...['ChatService', 'promptSections', 'assemble', 'reuse', 'keys', 'sessionStore', 'warmSession'].map(name => `src/engine/chat/${name}.ts`),
			'src/engine/mcp/bridge.ts',
			...['claude', 'codex', 'codexHome', 'google', 'generic'].map(name => `src/adapters/${name}.ts`),
			'src/hosts/http/host.ts',
			'src/hosts/http/wire.ts',
			'src/composition/headless.ts',
			'src/core/toolServer.ts',
		];
		const clientWords = /VS Code|Visual Studio|Copilot|Microsoft|['"`]vscode['"`]|mcp_+vscode|mcp_servers\.vscode/;
		for (const file of files) {
			expect(existsSync(file), `${file} exists`).toBe(true);
			const code = readFileSync(file, 'utf8').split('\n').filter(line => !/^(\/\/|\*|\/\*)/.test(line.trim()));
			for (const line of code) {
				expect(line, `${file} has client text`).not.toMatch(clientWords);
			}
		}
	});

	/** The chat modules that live in the engine. */
	for (const name of ['cache', 'sessionStore', 'sessionFingerprint', 'usage', 'promptSections']) {
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
		};
		const ctx: LaunchContext = { entryPath: 'fake', installDir: '', storageDir: '', settings: {}, workspaceFolder: '' };
		const log: Log = () => { };

		const client = new AgentClient(adapter, ctx, { log, storageDir: '', clientVersion: '0.0.0' });

		expect(client.isRunning).toBe(false);
		client.dispose();
	});
});
