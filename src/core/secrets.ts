import * as vscode from 'vscode';

function secretName(agentId: string): string {
	return `acpHub.apiKey.${agentId}`;
}

/** API keys, kept in VS Code's secret storage and never written to settings or logs. */
export class AgentSecretStore implements vscode.Disposable {

	private readonly listener: vscode.Disposable;
	private readonly changeEmitter = new vscode.EventEmitter<string>();
	/** Fires with the agent id when its key was saved or removed, possibly by another window. */
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.listener = secrets.onDidChange(event => {
			const prefix = secretName('');
			if (event.key.startsWith(prefix)) {
				this.changeEmitter.fire(event.key.slice(prefix.length));
			}
		});
	}

	async get(agentId: string): Promise<string | undefined> {
		const value = await this.secrets.get(secretName(agentId));
		return value || undefined;
	}

	async set(agentId: string, value: string): Promise<void> {
		await this.secrets.store(secretName(agentId), value);
	}

	async delete(agentId: string): Promise<void> {
		await this.secrets.delete(secretName(agentId));
	}

	dispose(): void {
		this.listener.dispose();
		this.changeEmitter.dispose();
	}
}
