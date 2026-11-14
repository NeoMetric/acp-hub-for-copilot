import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import { REGISTRY, registryAgent } from '../../src/core/registry';
import { activationEventsOf, applyRegistry, vendorOf, type RegistryFile } from '../../src/core/vendors';

const small: RegistryFile = {
	commonSettings: [{ key: 'idle', type: 'number', label: 'Idle', description: 'd', default: 5 }],
	agents: [
		{ id: 'one', displayName: 'One Agent', settings: [{ key: 'mode', type: 'enum', label: 'Mode', description: 'd', default: 'a', options: ['a', 'b'], optionDescriptions: ['A', 'B'] }] },
		{ id: 'two', displayName: 'Two Agent', settings: [{ key: 'args', type: 'string-list', label: 'Args', description: 'd', default: [] }] },
	],
};

/** Exactly what the released 0.0.6 manifest contributed and 1.0.0 does not. */
const LEGACY_SETTINGS = [
	'acpHub.resume.transcriptDetail',
	'acpHub.resume.transcriptMaxCharacters',
	'acpHub.resume.transcriptMaxToolResultCharacters',
	'acpHub.agents.claude.enabled',
	'acpHub.agents.claude.idleTimeoutSeconds',
	'acpHub.agents.claude.idleShutdownMinutes',
	'acpHub.agents.claude.dumpRequests',
	'acpHub.agents.claude.authPreference',
	'acpHub.agents.claude.toolSearch',
	'acpHub.agents.claude.replaceSystemPrompt',
	'acpHub.agents.codex.enabled',
	'acpHub.agents.codex.idleTimeoutSeconds',
	'acpHub.agents.codex.idleShutdownMinutes',
	'acpHub.agents.codex.dumpRequests',
	'acpHub.agents.codex.authPreference',
	'acpHub.agents.codex.maxContextWindow',
	'acpHub.agents.codex.replaceSystemPrompt',
	'acpHub.agents.google.enabled',
	'acpHub.agents.google.idleTimeoutSeconds',
	'acpHub.agents.google.idleShutdownMinutes',
	'acpHub.agents.google.dumpRequests',
	'acpHub.agents.google.authPreference',
	'acpHub.agents.google.command',
	'acpHub.agents.google.args',
	'acpHub.agents.google.useAgentBuiltInTools',
];

describe('vendors', () => {
	it('names a vendor after the agent id', () => {
		expect(vendorOf('one')).toBe('One Agent');
	});

	it('generates one provider and one activation event per agent', () => {
		const result = applyRegistry({ name: 'x', contributes: { commands: [] } }, small) as { contributes: { languageModelChatProviders: unknown[]; commands: unknown[] }; activationEvents: string[] };
		expect(result.contributes.languageModelChatProviders).toEqual([
			{ vendor: 'One Agent', displayName: 'One Agent' },
			{ vendor: 'Two Agent', displayName: 'Two Agent' },
		]);
		expect(result.contributes.commands).toEqual([]);
		expect(result.activationEvents).toEqual(['onStartupFinished', 'onLanguageModelChatProvider:One Agent', 'onLanguageModelChatProvider:Two Agent']);
	});

	it('generates no agent settings, since the sidebar and config.json hold them', () => {
		const result = applyRegistry({ name: 'x', contributes: { configuration: { title: 'ACP Hub', properties: {} } } }, small) as { contributes: { configuration: Record<string, unknown> } };
		expect(result.contributes.configuration).toEqual({ title: 'ACP Hub', properties: {} });
	});

	it('drops agent settings a previous version generated, and keeps every other setting', () => {
		const result = applyRegistry({ contributes: { configuration: { properties: {
			'acpHub.resume.transcriptDetail': { default: 'compact' },
			'acpHub.server.port': { type: 'number', default: 8791 },
			'acpHub.agents.removed.enabled': { default: true },
			'acpHub.agents.one.idle': { type: 'number', default: 5 },
		} } } }, small) as { contributes: { configuration: { properties: Record<string, unknown> } } };
		const properties = result.contributes.configuration.properties;
		expect(Object.keys(properties).sort()).toEqual(['acpHub.resume.transcriptDetail', 'acpHub.server.port']);
		expect(properties['acpHub.resume.transcriptDetail']).toEqual({ default: 'compact' });
		expect(properties['acpHub.server.port']).toEqual({ type: 'number', default: 8791 });
	});

	it('keeps a setting the extension declares as deprecated, so an older version is explained rather than unknown', () => {
		const result = applyRegistry({ contributes: { configuration: { properties: {
			'acpHub.agents.claude.enabled': { type: 'boolean', deprecationMessage: 'Moved to the ACP Hub store.' },
			'acpHub.agents.claude.idleTimeoutSeconds': { type: 'number' },
		} } } }, small) as { contributes: { configuration: { properties: Record<string, unknown> } } };
		expect(Object.keys(result.contributes.configuration.properties)).toEqual(['acpHub.agents.claude.enabled']);
		expect(result.contributes.configuration.properties['acpHub.agents.claude.enabled'])
			.toEqual({ type: 'boolean', deprecationMessage: 'Moved to the ACP Hub store.' });
	});

	it('deprecates exactly the settings the released 0.0.6 contributed', () => {
		const properties = packageJson.contributes.configuration.properties as Record<string, Record<string, unknown>>;
		const deprecated = Object.entries(properties)
			.filter(([, value]) => typeof value.deprecationMessage === 'string')
			.map(([key]) => key)
			.sort();
		expect(deprecated).toEqual([...LEGACY_SETTINGS].sort());
	});

	it('gives every deprecated setting a type and no default', () => {
		const properties = packageJson.contributes.configuration.properties as Record<string, Record<string, unknown>>;
		for (const key of LEGACY_SETTINGS) {
			expect(properties[key], key).toBeDefined();
			expect(properties[key].type, key).toBeDefined();
			expect(properties[key].default, key).toBeUndefined();
			expect(properties[key].deprecationMessage, key).toContain('ACP Hub');
		}
	});

	it('contributes only the settings the extension itself reads', () => {
		const properties = packageJson.contributes.configuration.properties as Record<string, Record<string, unknown>>;
		// The design: the port and the process model are the server's, so the window keeps only how it runs one; the
		// settings a previous version contributed stay as deprecated signposts, never as the source of a value.
		expect(Object.keys(properties).sort()).toEqual([...LEGACY_SETTINGS, 'acpHub.server.autoStart', 'acpHub.server.detached', 'acpHub.server.idleTimeoutMinutes'].sort());
		expect(properties['acpHub.server.detached']).toMatchObject({ type: 'boolean', default: true });
		expect(properties['acpHub.server.idleTimeoutMinutes']).toMatchObject({ type: 'number', default: 30, minimum: 0 });
		// Whether a window starts a server by itself is the window's business, never the server's.
		expect(properties['acpHub.server.autoStart']).toMatchObject({ type: 'boolean', default: true });
		// The idle limit leads the list in the Settings editor.
		expect(properties['acpHub.server.idleTimeoutMinutes'].order).toBe(0);
	});

	it('leaves the list of activation events free of duplicates', () => {
		const events = activationEventsOf(REGISTRY);
		expect(new Set(events).size).toBe(events.length);
	});
});

describe('registry', () => {
	it('bundles claude, codex and google', () => {
		expect(REGISTRY.agents.map(agent => agent.id)).toEqual(['claude', 'codex', 'google']);
	});

	it('throws for an unknown agent', () => {
		expect(() => registryAgent('nope')).toThrow('nope');
	});
});
