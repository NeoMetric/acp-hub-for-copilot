import type { AgentAdapter, UsageContext, UsageReading, UsageWindow } from './adapter';
import type { Log } from './logging';

/** A reading younger than this is reused instead of asking the agent again. */
export const FRESH_MS = 60_000;

export type UsageStatus = 'unsupported' | 'idle' | 'loading' | 'ok' | 'unavailable' | 'error';

export interface UsageState {
	status: UsageStatus;
	/** The latest good reading; kept when a later refresh fails. */
	reading?: UsageReading;
	error?: string;
	fetchedAt?: number;
	/** Windows the provider measured itself, such as the prompt cache hit rate. */
	extraWindows: UsageWindow[];
}

export type UsageListener = (agentId: string) => void;

/** Keeps the usage of every agent for the sidebar. */
export class UsageStore {
	private readonly states = new Map<string, UsageState>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly listeners: UsageListener[] = [];

	constructor(private readonly log: Log, private readonly now: () => number = Date.now) { }

	get(agentId: string): UsageState {
		return this.states.get(agentId) ?? { status: 'idle', extraWindows: [] };
	}

	/** Returns a function that removes the listener again. */
	onDidChange(listener: UsageListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	setExtraWindows(agentId: string, windows: UsageWindow[]): void {
		this.update(agentId, { extraWindows: windows });
	}

	/** Reads the usage of one agent. Reuses a fresh reading unless `force` is set. */
	refresh(adapter: AgentAdapter, ctx: UsageContext, force = false): Promise<void> {
		const source = adapter.usage;
		if (!source) {
			this.update(adapter.id, { status: 'unsupported' });
			return Promise.resolve();
		}

		const running = this.inFlight.get(adapter.id);
		if (running) {
			return running;
		}

		const state = this.get(adapter.id);
		const fresh = state.fetchedAt !== undefined && this.now() - state.fetchedAt < FRESH_MS;
		if (fresh && !force) {
			return Promise.resolve();
		}

		const task = this.load(adapter.id, source, ctx).finally(() => this.inFlight.delete(adapter.id));
		this.inFlight.set(adapter.id, task);
		return task;
	}

	private async load(agentId: string, source: NonNullable<AgentAdapter['usage']>, ctx: UsageContext): Promise<void> {
		this.update(agentId, { status: 'loading' });
		try {
			const reading = await source.read(ctx, new AbortController().signal);
			if (!reading) {
				this.update(agentId, { status: 'unavailable', error: undefined });
				return;
			}
			this.update(agentId, { status: 'ok', reading, error: undefined, fetchedAt: this.now() });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`Could not read usage of ${agentId}: ${message}`, 'warn');
			this.update(agentId, { status: 'error', error: message });
		}
	}

	private update(agentId: string, change: Partial<UsageState>): void {
		this.states.set(agentId, { ...this.get(agentId), ...change });
		for (const listener of [...this.listeners]) {
			listener(agentId);
		}
	}
}
