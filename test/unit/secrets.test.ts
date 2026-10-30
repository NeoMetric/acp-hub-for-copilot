import { describe, expect, it } from 'vitest';
import { AgentSecretStore } from '../../src/core/secrets';
import { FakeSecretStorage } from './secrets';

describe('AgentSecretStore', () => {
	it('stores, reads and deletes a key', async () => {
		const store = new AgentSecretStore(new FakeSecretStorage().asSecretStorage());
		await store.set('a', 'key-1');
		expect(await store.get('a')).toBe('key-1');
		await store.delete('a');
		expect(await store.get('a')).toBeUndefined();
	});

	it('keeps the keys of two agents apart', async () => {
		const store = new AgentSecretStore(new FakeSecretStorage().asSecretStorage());
		await store.set('a', 'key-a');
		await store.set('b', 'key-b');
		await store.delete('a');
		expect(await store.get('b')).toBe('key-b');
	});

	it('announces which agent changed, also for changes made elsewhere', () => {
		const fake = new FakeSecretStorage();
		const store = new AgentSecretStore(fake.asSecretStorage());
		const changed: string[] = [];
		store.onDidChange(id => changed.push(id));
		fake.storeFromElsewhere('acpHub.apiKey.codex', 'x');
		fake.storeFromElsewhere('unrelated', 'y');
		expect(changed).toEqual(['codex']);
	});
});
