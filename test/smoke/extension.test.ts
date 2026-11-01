import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('ACP Hub smoke test', () => {
	test('activates and registers its commands', async () => {
		const extension = vscode.extensions.getExtension('NeoMetric.acp-hub-for-copilot');
		assert.ok(extension);
		await extension.activate();
		assert.strictEqual(extension.isActive, true);
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['acpHub.showLogs', 'acpHub.signIn', 'acpHub.install', 'acpHub.refreshUsage']) {
			assert.ok(commands.includes(command), `${command} is not registered`);
		}
	});

	test('a model lookup completes when no agent is installed', async () => {
		await vscode.lm.selectChatModels({ vendor: 'Claude Agent' });
	});
});
