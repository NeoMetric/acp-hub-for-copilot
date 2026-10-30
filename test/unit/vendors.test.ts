import { describe, expect, it } from 'vitest';
import { REGISTRY, registryAgent } from '../../src/core/registry';
import { activationEventsOf, applyRegistry, configurationOf, vendorOf, type RegistryFile } from '../../src/core/vendors';

const small: RegistryFile = {
	commonSettings: [{ key: 'idle', type: 'number', label: 'Idle', description: 'd', default: 5 }],
	agents: [
		{ id: 'one', displayName: 'One Agent', settings: [{ key: 'mode', type: 'enum', label: 'Mode', description: 'd', default: 'a', options: ['a', 'b'], optionDescriptions: ['A', 'B'] }] },
		{ id: 'two', displayName: 'Two Agent', settings: [{ key: 'args', type: 'string-list', label: 'Args', description: 'd', default: [] }] },
	],
};

describe('vendors', () => {
	it('names a vendor after the agent id', () => {
		expect(vendorOf('one')).toBe('acphub-one');
	});

	it('generates one provider and one activation event per agent', () => {
		const result = applyRegistry({ name: 'x', contributes: { commands: [] } }, small) as { contributes: { languageModelChatProviders: unknown[]; commands: unknown[] }; activationEvents: string[] };
		expect(result.contributes.languageModelChatProviders).toEqual([
			{ vendor: 'acphub-one', displayName: 'One Agent' },
			{ vendor: 'acphub-two', displayName: 'Two Agent' },
		]);
		expect(result.contributes.commands).toEqual([]);
		expect(result.activationEvents).toEqual(['onStartupFinished', 'onLanguageModelChatProvider:acphub-one', 'onLanguageModelChatProvider:acphub-two']);
	});

	it('generates a setting for every common and own setting, plus enabled', () => {
		const properties = (configurationOf(small) as { properties: Record<string, Record<string, unknown>> }).properties;
		expect(Object.keys(properties).sort()).toEqual([
			'acpHub.agents.one.enabled', 'acpHub.agents.one.idle', 'acpHub.agents.one.mode',
			'acpHub.agents.two.args', 'acpHub.agents.two.enabled', 'acpHub.agents.two.idle',
		]);
		expect(properties['acpHub.agents.one.mode']).toMatchObject({ type: 'string', enum: ['a', 'b'], default: 'a' });
		expect(properties['acpHub.agents.two.args']).toMatchObject({ type: 'array', items: { type: 'string' } });
		expect(properties['acpHub.agents.one.idle']).toMatchObject({ type: 'number', minimum: 0, default: 5 });
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
