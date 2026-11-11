import { describe, expect, it } from 'vitest';
import { effortFor } from '../../src/engine/chat/modelOptions';

describe('effortFor', () => {
	it('gives a request that names no effort, or the agent\'s own default, the configured one', () => {
		expect(effortFor(undefined, { defaultEffort: 'high' })).toBe('high');
		expect(effortFor('default', { defaultEffort: 'high' })).toBe('high');
	});

	it('keeps an effort the user picked', () => {
		expect(effortFor('max', { defaultEffort: 'high' })).toBe('max');
		expect(effortFor('low', { defaultEffort: 'high' })).toBe('low');
	});

	it('leaves the request alone when no effort is configured, or the agent is left to choose', () => {
		expect(effortFor(undefined, undefined)).toBeUndefined();
		expect(effortFor('default', {})).toBe('default');
		expect(effortFor(undefined, { defaultEffort: 'default' })).toBeUndefined();
		expect(effortFor('default', { defaultEffort: '' })).toBe('default');
		expect(effortFor(undefined, { defaultEffort: 3 })).toBeUndefined();
	});
});
