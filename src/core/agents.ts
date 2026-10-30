import { claudeAdapter } from '../adapters/claude';
import { codexAdapter } from '../adapters/codex';
import { googleAdapter } from '../adapters/google';
import type { AgentAdapter } from './adapter';

export const ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter, googleAdapter];

export function findAdapter(id: string): AgentAdapter | undefined {
	return ADAPTERS.find(adapter => adapter.id === id);
}
