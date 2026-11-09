import * as vscode from 'vscode';
import type { SecretStore } from '../engine/ports/state';

function secretName(agentId: string): string {
	return `acpHub.apiKey.${agentId}`;
}

/**
 * API keys, kept in the shared store and mirrored into VS Code's secret storage
 * so a downgrade still finds them. The shared file is the source of truth: a key
 * saved by the headless gateway is read here, and one only the mirror holds —
 * saved before the store existed — is read from the mirror.
 */
export class AgentSecretStore implements vscode.Disposable {

	private readonly listener: vscode.Disposable;
	private readonly changeEmitter = new vscode.EventEmitter<string>();
	/** Fires with the agent id when its key was saved or removed, possibly by another window. */
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly secrets: vscode.SecretStorage, private readonly shared?: SecretStore) {
		this.listener = secrets.onDidChange(event => {
			const prefix = secretName('');
			if (event.key.startsWith(prefix)) {
				this.changeEmitter.fire(event.key.slice(prefix.length));
			}
		});
	}

	async get(agentId: string): Promise<string | undefined> {
		const shared = await this.fromShared(agentId);
		if (shared) {
			return shared;
		}
		const value = await this.secrets.get(secretName(agentId));
		return value || undefined;
	}

	async set(agentId: string, value: string): Promise<void> {
		if (this.shared) {
			await this.shared.set(agentId, value);
		}
		await this.mirror(async () => { await this.secrets.store(secretName(agentId), value); });
	}

	async delete(agentId: string): Promise<void> {
		if (this.shared) {
			await this.shared.delete(agentId);
		}
		await this.mirror(async () => { await this.secrets.delete(secretName(agentId)); });
	}

	dispose(): void {
		this.listener.dispose();
		this.changeEmitter.dispose();
	}

	/** The shared store answers first; one that cannot be read leaves the mirror to answer. */
	private async fromShared(agentId: string): Promise<string | undefined> {
		if (!this.shared) {
			return undefined;
		}
		try {
			return await this.shared.get(agentId);
		} catch {
			return undefined;
		}
	}

	/** The mirror is a convenience: a key the shared store holds stays saved even when VS Code refuses it. */
	private async mirror(write: () => Promise<void>): Promise<void> {
		try {
			await write();
		} catch { /* Best effort, as a mirror is. */ }
	}
}
