import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCliProviders, copilotProvidersFile, writeVendorNames } from '../../src/hosts/vscode/applyNames';

/** The byte order mark Windows tools write at the start of a JSON file. */
const BOM = String.fromCharCode(0xfeff);

const folders: string[] = [];

function tempFile(name: string, content?: string): string {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hub-names-'));
	folders.push(folder);
	const file = path.join(folder, name);
	if (content !== undefined) {
		fs.writeFileSync(file, content);
	}
	return file;
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

const BASE = { baseUrl: 'http://127.0.0.1:8791/v1', token: 'secret' };

describe('writeCliProviders', () => {
	it('writes one provider per agent and one model per entry, creating the file', () => {
		const file = path.join(path.dirname(tempFile('x')), 'sub', 'providers.json');

		const { written } = writeCliProviders({
			file, ...BASE, previous: [],
			providers: [{ name: 'Work Claude', models: [{ name: 'Sonnet 5.5', wireModel: 'claude/sonnet' }] }],
		});

		expect(written).toEqual(['Work Claude']);
		const config = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect(config.providers).toEqual([{ name: 'Work Claude', type: 'openai', baseUrl: BASE.baseUrl, bearerToken: 'secret' }]);
		expect(config.models).toEqual([{ id: 'Sonnet-5.5', provider: 'Work Claude', wireModel: 'claude/sonnet' }]);
	});

	it('keeps entries it did not write and replaces the ones it wrote before, and the legacy acp-hub ones', () => {
		const file = tempFile('providers.json', JSON.stringify({
			providers: [{ name: 'mine', type: 'openai', baseUrl: 'http://x' }, { name: 'Old Claude', type: 'openai', baseUrl: 'http://old' }, { name: 'acp-hub', type: 'openai', baseUrl: 'http://old' }],
			models: [{ id: 'keep', provider: 'mine', wireModel: 'k' }, { id: 'old', provider: 'Old Claude', wireModel: 'o' }, { id: 'legacy', provider: 'acp-hub', wireModel: 'l' }],
		}));

		writeCliProviders({ file, ...BASE, previous: ['Old Claude'], providers: [{ name: 'New Claude', models: [{ name: 'A', wireModel: 'claude/a' }] }] });

		const config = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect(config.providers.map((provider: { name: string }) => provider.name)).toEqual(['mine', 'New Claude']);
		expect(config.models.map((model: { id: string }) => model.id)).toEqual(['keep', 'A']);
	});

	it('makes ids slash-free and unique', () => {
		const file = tempFile('providers.json');

		writeCliProviders({
			file, ...BASE, previous: [],
			providers: [{ name: 'P', models: [{ name: 'A/B', wireModel: 'p/1' }, { name: 'A B', wireModel: 'p/2' }] }],
		});

		const ids = JSON.parse(fs.readFileSync(file, 'utf8')).models.map((model: { id: string }) => model.id);
		expect(ids).toEqual(['A-B', 'A-B-2']);
	});

	it('leaves the bearer token out when there is none', () => {
		const file = tempFile('providers.json');

		writeCliProviders({ file, baseUrl: BASE.baseUrl, token: undefined, previous: [], providers: [{ name: 'P', models: [] }] });

		expect(JSON.parse(fs.readFileSync(file, 'utf8')).providers[0]).not.toHaveProperty('bearerToken');
	});

	it('reads a file that starts with a byte order mark', () => {
		const file = tempFile('providers.json', `${BOM}${JSON.stringify({ providers: [{ name: 'mine', type: 'openai', baseUrl: 'http://x' }], models: [] })}`);

		writeCliProviders({ file, ...BASE, previous: [], providers: [{ name: 'P', models: [] }] });

		const text = fs.readFileSync(file, 'utf8');
		expect(text.startsWith('{')).toBe(true);
		expect(JSON.parse(text).providers.map((provider: { name: string }) => provider.name)).toEqual(['mine', 'P']);
	});

	it('refuses a file that is not valid JSON and leaves it as it was', () => {
		const file = tempFile('providers.json', '{ not json');

		expect(() => writeCliProviders({ file, ...BASE, previous: [], providers: [] })).toThrow(/providers\.json/);
		expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
	});
});

describe('writeVendorNames', () => {
	const MANIFEST = {
		name: 'x',
		contributes: { languageModelChatProviders: [{ vendor: 'Claude Agent', displayName: 'Claude Agent' }, { vendor: 'Codex Agent', displayName: 'Codex Agent' }] },
	};

	it('changes only the named vendor and keeps the indentation', () => {
		const file = tempFile('package.json', `${JSON.stringify(MANIFEST, null, '\t')}\n`);

		writeVendorNames({ packageJson: file, names: { 'Claude Agent': 'Work Claude' } });

		const text = fs.readFileSync(file, 'utf8');
		expect(text.startsWith('{\n\t"name"')).toBe(true);
		expect(text.endsWith('}\n')).toBe(true);
		const providers = JSON.parse(text).contributes.languageModelChatProviders;
		expect(providers).toEqual([{ vendor: 'Claude Agent', displayName: 'Work Claude' }, { vendor: 'Codex Agent', displayName: 'Codex Agent' }]);
	});

	it('reads a manifest that starts with a byte order mark', () => {
		const file = tempFile('package.json', `${BOM}${JSON.stringify(MANIFEST, null, '\t')}`);

		writeVendorNames({ packageJson: file, names: { 'Claude Agent': 'Work Claude' } });

		expect(JSON.parse(fs.readFileSync(file, 'utf8')).contributes.languageModelChatProviders[0].displayName).toBe('Work Claude');
	});

	it('throws when the file is missing', () => {
		expect(() => writeVendorNames({ packageJson: path.join(os.tmpdir(), 'acp-hub-no-such', 'package.json'), names: { 'Claude Agent': 'X' } })).toThrow();
	});

	it('answers whether the manifest changed, so the caller knows a reload is due', () => {
		const file = tempFile('package.json', `${JSON.stringify(MANIFEST, null, '\t')}\n`);

		expect(writeVendorNames({ packageJson: file, names: { 'Claude Agent': 'Work Claude' } })).toBe(true);
		expect(writeVendorNames({ packageJson: file, names: { 'Claude Agent': 'Work Claude' } })).toBe(false);
	});
});

describe('copilotProvidersFile', () => {
	afterEach(() => {
		delete process.env.COPILOT_PROVIDERS_CONFIG;
	});

	it('reads the file the environment names, and the home folder otherwise', () => {
		expect(copilotProvidersFile()).toBe(path.join(os.homedir(), '.copilot', 'providers.json'));

		process.env.COPILOT_PROVIDERS_CONFIG = path.join(os.tmpdir(), 'mine.json');

		expect(copilotProvidersFile()).toBe(path.join(os.tmpdir(), 'mine.json'));
	});
});
