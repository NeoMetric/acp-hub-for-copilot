import * as vscode from 'vscode';

const SPIKE_VENDORS = ['acphub-claude', 'acphub-codex', 'acphub-google'];

class SpikeProvider implements vscode.LanguageModelChatProvider {
	constructor(private readonly vendor: string) { }

	provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
		return [{
			id: `${this.vendor}-spike`,
			name: `${this.vendor} spike`,
			family: this.vendor,
			version: '1',
			maxInputTokens: 100_000,
			maxOutputTokens: 4_000,
			capabilities: { toolCalling: false },
		}];
	}

	provideLanguageModelChatResponse(
		_model: vscode.LanguageModelChatInformation,
		_messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): Promise<void> {
		progress.report(new vscode.LanguageModelTextPart('spike ok'));
		return Promise.resolve();
	}

	provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		return Promise.resolve(typeof value === 'string' ? Math.ceil(value.length / 4) : 1);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	for (const vendor of SPIKE_VENDORS) {
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(vendor, new SpikeProvider(vendor)));
	}
}

export function deactivate(): void { }
