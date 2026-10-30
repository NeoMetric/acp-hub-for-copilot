import type { AgentAdapter } from './adapter';

export const ADAPTERS: AgentAdapter[] = [];

export function findAdapter(id: string): AgentAdapter | undefined {
	return ADAPTERS.find(adapter => adapter.id === id);
}
