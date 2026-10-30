import { claudeAdapter } from '../adapters/claude';
import { codexAdapter } from '../adapters/codex';
import { googleAdapter } from '../adapters/google';
import { manifestToAdapter } from '../adapters/generic';
import { REGISTRY } from './registry';
import type { RegistryFile } from './vendors';
import type { AgentAdapter } from './adapter';

const BUILT_IN_ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter, googleAdapter];

export function adaptersFromRegistry(registry: RegistryFile): AgentAdapter[] {
	return registry.agents.map(entry => {
		const builtIn = BUILT_IN_ADAPTERS.find(adapter => adapter.id === entry.id);
		if (builtIn) { return builtIn; }
		if (!entry.install || !entry.launch || !entry.auth) {
			throw new Error(`Agent ${entry.id} needs an adapter or a complete launch specification.`);
		}
		return manifestToAdapter({
			...entry, install: entry.install, launch: entry.launch, auth: entry.auth,
			settings: [...registry.commonSettings, ...entry.settings],
		});
	});
}

export const ADAPTERS: AgentAdapter[] = adaptersFromRegistry(REGISTRY);

export function findAdapter(id: string): AgentAdapter | undefined {
	return ADAPTERS.find(adapter => adapter.id === id);
}
