import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelNames } from '../../src/engine/models/modelNames';
import type { StateStore } from '../../src/engine/ports/state';
import type { ModelWire } from '../../src/hosts/http/wire';
import { syncModels, type SyncModelsDeps } from '../../src/hosts/vscode/syncModels';
import type { ServerEndpoint } from '../../src/hosts/vscode/serverLink';

const folders: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
	for (const folder of folders.splice(0)) {
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

function memoryState(): StateStore {
	const values: Record<string, unknown> = {};
	return { get: <T>(key: string) => values[key] as T | undefined, update: async (key, value) => { values[key] = value; }, keys: () => Object.keys(values) };
}

/** One model as `/v1/models` publishes it, named the way the server shows it. */
function wireOf(value: string, name: string): ModelWire {
	return {
		id: `claude/${value}`,
		object: 'model',
		created: 1,
		owned_by: 'claude',
		acp: { name, family: 'f', version: '1', maxInputTokens: 1000, maxOutputTokens: 100, toolCalling: true, imageInput: false, efforts: [] },
	};
}

/** A loopback server that answers the refresh and the model list the test writes, and the endpoint that reaches it. */
async function serve(models: readonly ModelWire[], options: { refreshStatus?: number } = {}): Promise<ServerEndpoint> {
	const server = http.createServer((request, response) => {
		if (request.url === '/v1/models/refresh') {
			response.writeHead(options.refreshStatus ?? 200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ refreshed: ['claude'] }));
			return;
		}
		if (request.url === '/v1/models') {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ object: 'list', data: models }));
			return;
		}
		response.writeHead(404);
		response.end();
	});
	servers.push(server);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'secret' };
}

function setup(models: readonly ModelWire[], options: { refreshStatus?: number; packageJson?: string } = {}) {
	return (async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-sync-'));
		folders.push(folder);
		const providersFile = path.join(folder, 'providers.json');
		const packageJson = options.packageJson ?? path.join(folder, 'package.json');
		if (options.packageJson === undefined) {
			fs.writeFileSync(packageJson, JSON.stringify({ contributes: { languageModelChatProviders: [{ vendor: 'Claude Agent', displayName: 'Claude Agent' }] } }, null, '\t'));
		}
		const state = memoryState();
		const names = new ModelNames(state);
		const endpoint = await serve(models, options);
		const deps: SyncModelsDeps = { endpoint, agents: [{ id: 'claude', displayName: 'Claude Agent' }], names, state, packageJson, providersFile };
		return { deps, endpoint, providersFile, packageJson, state, names };
	})();
}

const read = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('syncModels', () => {
	it('writes one provider per agent the server published, with the names the user chose', async () => {
		const { deps, endpoint, providersFile, packageJson } = await setup([wireOf('sonnet', 'Fast one')]);

		const outcome = await syncModels(deps);

		const config = read(providersFile);
		expect(config.providers).toEqual([{ name: 'Claude Agent', type: 'openai', baseUrl: `${endpoint.baseUrl}/v1`, bearerToken: 'secret' }]);
		expect(config.models).toEqual([{ id: 'Fast-one', provider: 'Claude Agent', wireModel: 'claude/sonnet' }]);
		expect(outcome).toMatchObject({ refreshed: ['claude'], providers: 1, models: 1, problems: [], reloadNeeded: false });
		expect(read(packageJson).contributes.languageModelChatProviders[0].displayName).toBe('Claude Agent');
	});

	it('shows the provider name the user chose', async () => {
		const { deps, names, providersFile, packageJson } = await setup([wireOf('sonnet', 'Fast one')]);
		await names.setProvider('claude', 'Work Claude', new Map([['claude', 'Claude Agent']]));

		const outcome = await syncModels(deps);

		expect(read(providersFile).providers[0].name).toBe('Work Claude');
		expect(read(providersFile).models[0].provider).toBe('Work Claude');
		expect(read(packageJson).contributes.languageModelChatProviders[0].displayName).toBe('Work Claude');
		expect(outcome.reloadNeeded).toBe(true);
	});

	it('keeps the entries it did not write', async () => {
		const { deps, providersFile } = await setup([wireOf('sonnet', 'Fast one')]);
		fs.writeFileSync(providersFile, JSON.stringify({ providers: [{ name: 'github' }, { name: 'acp-hub' }], models: [{ id: 'keep', provider: 'github' }, { id: 'drop', provider: 'acp-hub' }] }));

		await syncModels(deps);

		expect(read(providersFile).providers.map((entry: { name: string }) => entry.name)).toEqual(['github', 'Claude Agent']);
		expect(read(providersFile).models.map((entry: { id: string }) => entry.id)).toEqual(['keep', 'Fast-one']);
	});

	it('gives two models that show the same name distinct ids', async () => {
		const { deps, providersFile } = await setup([wireOf('sonnet', 'Fast one'), wireOf('opus', 'Fast one')]);

		await syncModels(deps);

		expect(read(providersFile).models.map((entry: { id: string }) => entry.id)).toEqual(['Fast-one', 'Fast-one-2']);
	});

	it('leaves providers.json alone when no agent offers a model, and says so', async () => {
		const { deps, providersFile } = await setup([]);
		fs.writeFileSync(providersFile, JSON.stringify({ providers: [{ name: 'mine' }], models: [] }));

		const outcome = await syncModels(deps);

		expect(read(providersFile).providers).toEqual([{ name: 'mine' }]);
		expect(outcome.problems).toEqual(['No agent offered a model, so providers.json was left as it was.']);
	});

	it('reports a providers.json it cannot parse and still writes the manifest', async () => {
		const { deps, providersFile, packageJson, names } = await setup([wireOf('sonnet', 'Fast one')]);
		await names.setProvider('claude', 'Work Claude', new Map([['claude', 'Claude Agent']]));
		fs.writeFileSync(providersFile, 'not json');

		const outcome = await syncModels(deps);

		expect(outcome.problems[0]).toContain('is not a JSON object');
		expect(read(packageJson).contributes.languageModelChatProviders[0].displayName).toBe('Work Claude');
	});

	it('reports a manifest it cannot write and still writes providers.json', async () => {
		const { deps, providersFile } = await setup([wireOf('sonnet', 'Fast one')], { packageJson: path.join(os.tmpdir(), 'acp-hub-no-such-sync', 'package.json') });

		const outcome = await syncModels(deps);

		expect(outcome.problems[0]).toContain('VS Code: could not update');
		expect(read(providersFile).providers).toHaveLength(1);
	});

	it('reports the providers it meant to write even when the CLI file is refused', async () => {
		const { deps, providersFile } = await setup([wireOf('sonnet', 'Fast one')]);
		fs.writeFileSync(providersFile, 'not json');

		const outcome = await syncModels(deps);

		expect(outcome.problems[0]).toContain('is not a JSON object');
		expect(outcome).toMatchObject({ providers: 1, models: 1 });
	});

	it('goes on with the published list when the refresh is refused, and says so', async () => {
		const { deps, providersFile } = await setup([wireOf('sonnet', 'Fast one')], { refreshStatus: 500 });

		const outcome = await syncModels(deps);

		expect(outcome.problems[0]).toContain("could not be read again");
		expect(read(providersFile).models).toHaveLength(1);
	});
});
