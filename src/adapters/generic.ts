import type { AgentAdapter, AuthMethodSpec, SettingSpec } from '../core/adapter';
import { vendorOf } from '../core/vendors';

export interface ManifestEntry {
	id: string;
	displayName: string;
	settings: SettingSpec[];
	install: { kind: 'npm'; package: string; version: string; entry?: string }
		| { kind: 'existing-cli'; command: string };
	launch: { args: string[]; env?: Record<string, string> };
	auth: AuthMethodSpec[];
}

export function manifestToAdapter(entry: ManifestEntry): AgentAdapter {
	const install = entry.install.kind === 'npm'
		? { kind: 'npm' as const, packageName: entry.install.package, version: entry.install.version, manifestDirectory: `adapters/${entry.id}`, entry: entry.install.entry }
		: { kind: 'existing-cli' as const, command: entry.install.command };
	return {
		id: entry.id,
		displayName: entry.displayName,
		vendor: vendorOf(entry.id),
		install,
		launch: ctx => {
			const env = { ...entry.launch.env };
			for (const method of entry.auth) {
				if (method.kind === 'api-key' && ctx.apiKey) { env[method.envVar] = ctx.apiKey; }
			}
			if (entry.install.kind === 'npm') {
				return { command: process.execPath, args: [ctx.entryPath, ...entry.launch.args], env };
			}
			return { command: ctx.entryPath, args: [...entry.launch.args], env };
		},
		auth: entry.auth,
		authenticate: (methods, apiKey) => {
			if (!apiKey) { return undefined; }
			for (const method of entry.auth) {
				if (method.kind !== 'api-key') { continue; }
				const methodId = method.agentMethodId ?? 'api-key';
				if (methods.some(advertised => advertised.id === methodId)) { return { methodId }; }
			}
			return undefined;
		},
		settings: entry.settings,
		modelPolicy: {
			detail: entry.displayName,
			familyOf: value => value,
			contextWindowOf: () => 128_000,
			maxOutputTokens: 8_192,
			effortConfigId: 'effort',
			effortLabel: value => value,
			effortDescription: value => value,
			defaultEffort: levels => levels[0] ?? '',
			fallbackTooltip: name => `${name} via ${entry.displayName}.`,
			thinkingDescription: 'Controls the amount of reasoning.',
		},
		systemPrompt: {
			toolAccess: 'The tools of the MCP server named vscode are VS Code tools for the current workspace.',
			listRequiredArguments: false,
		},
	};
}
