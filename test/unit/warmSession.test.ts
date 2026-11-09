import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapter';
import { WarmSession } from '../../src/engine/chat/warmSession';
import type { ToolBridge } from '../../src/engine/chat/types';

function warmSession(declaresBridgeOnModelLookup: boolean) {
	const createSession = vi.fn(async () => ({ sessionId: 'warm', configOptions: [] }));
	const bridge = {
		registerSession: vi.fn(async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'token' })),
		unregisterSession: vi.fn(),
	};
	const session = new WarmSession({
		adapter: { declaresBridgeOnModelLookup } as AgentAdapter,
		bridge: bridge as unknown as ToolBridge,
		agentClient: async () => ({ createSession }) as never,
		cwd: () => '/work',
		opened: () => undefined,
	});
	return { session, createSession };
}

describe('WarmSession', () => {
	it('opens a session the agent need not keep a transcript of', async () => {
		const { session, createSession } = warmSession(false);

		await session.ensure();

		expect(createSession).toHaveBeenCalledWith({ cwd: '/work', mcpServers: [], ephemeral: true });
	});

	it('also does so when the session declares the tool bridge', async () => {
		const { session, createSession } = warmSession(true);

		await session.ensure();

		expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/work', ephemeral: true }));
	});

	it('reuses the open session instead of opening another', async () => {
		const { session, createSession } = warmSession(false);

		await session.ensure();
		await session.ensure();

		expect(createSession).toHaveBeenCalledTimes(1);
	});
});
