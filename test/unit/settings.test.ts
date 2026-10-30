import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import { readAgentSettings } from '../../src/core/settings';

const adapter = {
	id: 'demo',
	settings: [
		{ key: 'exampleMode', type: 'enum', label: 'Example mode', default: 'default', options: ['default', 'plan'] },
		{ key: 'timeoutSeconds', type: 'number', label: 'Timeout', default: 120 },
		{ key: 'verbose', type: 'boolean', label: 'Verbose', default: false },
	],
} as unknown as AgentAdapter;

function configOf(values: Record<string, unknown>) {
	return { get: <T>(name: string) => values[name] as T | undefined };
}

describe('readAgentSettings', () => {
	it('returns the defaults when nothing is set', () => {
		const result = readAgentSettings(adapter, configOf({}));
		expect(result.values).toEqual({ exampleMode: 'default', timeoutSeconds: 120, verbose: false });
		expect(result.warnings).toEqual([]);
	});

	it('reads values stored under acpHub.agents.<id>.<key>', () => {
		const result = readAgentSettings(adapter, configOf({ 'agents.demo.exampleMode': 'plan', 'agents.demo.verbose': true }));
		expect(result.values.exampleMode).toBe('plan');
		expect(result.values.verbose).toBe(true);
	});

	it('falls back to the default and warns on a wrong type', () => {
		const result = readAgentSettings(adapter, configOf({ 'agents.demo.timeoutSeconds': 'soon' }));
		expect(result.values.timeoutSeconds).toBe(120);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('acpHub.agents.demo.timeoutSeconds');
	});

	it('accepts a list of strings and rejects anything else for a list setting', () => {
		const listAdapter = { id: 'demo', settings: [{ key: 'args', type: 'string-list', label: 'Args', description: '', default: [] }] } as unknown as AgentAdapter;
		expect(readAgentSettings(listAdapter, configOf({ 'agents.demo.args': ['--a', 'b'] })).values.args).toEqual(['--a', 'b']);
		const bad = readAgentSettings(listAdapter, configOf({ 'agents.demo.args': ['--a', 3] }));
		expect(bad.values.args).toEqual([]);
		expect(bad.warnings).toHaveLength(1);
	});

	it('rejects a negative number and an enum value that is not offered', () => {
		const result = readAgentSettings(adapter, configOf({ 'agents.demo.timeoutSeconds': -5, 'agents.demo.exampleMode': 'bogus' }));
		expect(result.values).toEqual({ exampleMode: 'default', timeoutSeconds: 120, verbose: false });
		expect(result.warnings).toHaveLength(2);
	});
});
