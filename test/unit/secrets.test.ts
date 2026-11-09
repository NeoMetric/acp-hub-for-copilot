import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { AgentSecretStore } from '../../src/core/secrets';
import type { SecretStore } from '../../src/engine/ports/state';
import { FakeSecretStorage } from './secrets';

/** The shared store the other gateway writes, kept in memory. */
class FakeSharedSecrets implements SecretStore {
	private readonly values = new Map<string, string>();

	async get(id: string): Promise<string | undefined> {
		return this.values.get(id);
	}

	async set(id: string, value: string): Promise<void> {
		this.values.set(id, value);
	}

	async delete(id: string): Promise<void> {
		this.values.delete(id);
	}
}

/** Secret storage that refuses every write, as a locked keychain would. */
function refusingSecretStorage(): vscode.SecretStorage {
	return {
		onDidChange: () => ({ dispose() {} }),
		get: async () => undefined,
		store: async () => { throw new Error('the keychain refused the key'); },
		delete: async () => { throw new Error('the keychain refused the key'); },
	} as unknown as vscode.SecretStorage;
}

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

	it('writes a key to the shared store and the mirror, and reads the shared one first', async () => {
		const mirror = new FakeSecretStorage();
		const shared = new FakeSharedSecrets();
		const store = new AgentSecretStore(mirror.asSecretStorage(), shared);
		await store.set('claude', 'from-this-window');
		mirror.storeFromElsewhere('acpHub.apiKey.claude', 'an-older-mirror-key');

		expect(await store.get('claude')).toBe('from-this-window');
		expect(await shared.get('claude')).toBe('from-this-window');
	});

	it('falls back to the mirror for a key the shared store has not got', async () => {
		const mirror = new FakeSecretStorage();
		await mirror.store('acpHub.apiKey.claude', 'saved-before-the-store');
		const store = new AgentSecretStore(mirror.asSecretStorage(), new FakeSharedSecrets());

		expect(await store.get('claude')).toBe('saved-before-the-store');
	});

	it('deletes the key from both stores', async () => {
		const mirror = new FakeSecretStorage();
		const shared = new FakeSharedSecrets();
		const store = new AgentSecretStore(mirror.asSecretStorage(), shared);
		await store.set('claude', 'key');
		await store.delete('claude');

		expect(await shared.get('claude')).toBeUndefined();
		expect(await store.get('claude')).toBeUndefined();
	});

	it('keeps the key in the shared store when the mirror refuses it', async () => {
		const shared = new FakeSharedSecrets();
		const store = new AgentSecretStore(refusingSecretStorage(), shared);

		await store.set('claude', 'key');
		await store.delete('claude');

		expect(await shared.get('claude')).toBeUndefined();
	});
});
