import registryJson from '../../registry/agents.json';
import type { RegistryAgent, RegistryFile } from './vendors';

export const REGISTRY: RegistryFile = registryJson as RegistryFile;

/** The registry entry of a bundled agent; throws for an id that is not in the registry. */
export function registryAgent(id: string): RegistryAgent {
	const agent = REGISTRY.agents.find(entry => entry.id === id);
	if (!agent) {
		throw new Error(`Agent "${id}" is not in registry/agents.json.`);
	}
	return agent;
}
