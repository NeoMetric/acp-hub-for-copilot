import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { manifestToAdapter } from '../../src/adapters/generic';
import { AgentClient } from '../../src/core/agentClient';
import { findAdapterEntry } from '../../src/core/npmInstaller';
import { adaptersFromRegistry } from '../../src/core/agents';

it('includes a manifest-only agent alongside the built-in adapters', () => {
	const adapters = adaptersFromRegistry({
		commonSettings: [],
		agents: [{
			id: 'fixture', displayName: 'Fixture', settings: [],
			install: { kind: 'existing-cli', command: 'fixture-agent' },
			launch: { args: [] }, auth: [],
		}],
	});
	expect(adapters.map(adapter => adapter.id)).toContain('fixture');
});

it('uses an explicit npm entry when the package has no bin', async () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-entry-'));
	try {
		const packageDir = path.join(temp, 'node_modules', 'fixture');
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, 'package.json'), '{}');
		fs.writeFileSync(path.join(packageDir, 'server.js'), '');
		expect(await findAdapterEntry(temp, 'fixture', 'server.js')).toBe(path.join(packageDir, 'server.js'));
		expect(await findAdapterEntry(temp, 'fixture', '../other.js')).toBeUndefined();
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

it('starts a registry-only agent and streams its reply', async () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-generic-'));
	const script = path.resolve(__dirname, '..', 'fixtures', 'mock-acp-agent.cjs');
	const adapter = manifestToAdapter({
		id: 'fixture', displayName: 'Fixture', settings: [],
		install: { kind: 'existing-cli', command: process.execPath },
		launch: { args: [script], env: { MOCK_ACP_MODE: 'key-auth' } },
		auth: [{ kind: 'api-key', label: 'Fixture key', envVar: 'MOCK_API_KEY', agentMethodId: 'mock-login' }],
	});
	const ctx = { entryPath: process.execPath, installDir: '', storageDir: temp, workspaceFolder: temp, settings: {}, apiKey: 'fixture-key' };
	const client = new AgentClient(adapter, ctx, { log: () => {}, storageDir: temp, clientVersion: '1' });
	try {
		const session = await client.createSession({ cwd: temp, mcpServers: [] });
		let response = '';
		await client.prompt(session.sessionId, [{ type: 'text', text: 'hi' }], { onText: text => { response += text; } });
		expect(adapter.vendor).toBe('Fixture Agent');
		expect(response).toBe('hello');
	} finally {
		await client.restart();
		client.dispose();
		fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
