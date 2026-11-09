import type * as vscode from 'vscode';
import type { StateStore } from '../engine/ports/state';

/**
 * Extension state as the engine's store. The host hands back a thenable rather
 * than a promise, so a write is awaited before it is reported as done.
 */
export function stateStoreOf(state: vscode.Memento | undefined): StateStore | undefined {
	if (state === undefined) {
		return undefined;
	}
	return {
		get: <T>(key: string) => state.get<T>(key),
		update: async (key, value) => { await state.update(key, value); },
		keys: () => state.keys(),
	};
}
