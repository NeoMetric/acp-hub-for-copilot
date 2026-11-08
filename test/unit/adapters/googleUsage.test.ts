import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSettings, UsageContext } from '../../../src/core/adapter';
import { quotaUsage, type QuotaEnvironment } from '../../../src/adapters/googleUsage';

/** What `RetrieveUserQuotaSummary` answers, as the Antigravity CLI 1.5.3 sends it. */
const summary = {
	response: {
		groups: [
			{
				displayName: 'Gemini Models',
				description: 'Models within this group: Gemini Flash, Gemini Pro',
				buckets: [
					{ bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', description: 'You have used some of your weekly limit.', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-11-14T07:36:20Z' },
					{ bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', description: 'You have used some of your 5-hour limit.', window: '5h', remainingFraction: 0.976, resetTime: '2026-11-08T08:29:53Z' },
				],
			},
			{
				displayName: 'Claude and GPT models',
				description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
				buckets: [
					{ bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0, resetTime: '2026-11-08T10:06:03Z' },
					{ bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T09:11:08Z' },
				],
			},
		],
		description: 'Within each group, models share a weekly limit and a 5-hour limit.',
	},
};

const NOT_SIGNED_IN = new Error('The Antigravity CLI answered RetrieveUserQuotaSummary with HTTP 500: {"code":"internal","message":"internal: failed to get load code assist response: error getting token source: You are not logged into Antigravity."}');

function context(settings: AgentSettings = {}, apiKey?: string): UsageContext {
	return {
		launch: { entryPath: 'C:\\agy\\agy.exe', installDir: '', storageDir: 'C:\\storage\\google', settings, apiKey, workspaceFolder: '' },
		askAgent: async () => { throw new Error('the quota is not read through the chat'); },
	};
}

function environment(...answers: Array<unknown>) {
	const stop = vi.fn(async () => undefined);
	const hub = { port: 1, token: 't', stop };
	const env: QuotaEnvironment = {
		startHub: vi.fn(async () => hub),
		call: vi.fn(async () => {
			const answer = answers.length > 1 ? answers.shift() : answers[0];
			if (answer instanceof Error) { throw answer; }
			return answer;
		}),
		wait: vi.fn(async () => undefined),
	};
	return { env, stop };
}

const signal = new AbortController().signal;

describe('Google usage', () => {
	it('turns each quota bucket into a usage window', async () => {
		const { env } = environment(summary);

		const reading = await quotaUsage(env).read(context(), signal);

		expect(reading?.windows).toEqual([
			{ label: 'Gemini Models · Weekly', usedPercent: 25, resets: 'Nov 14, 2026, 07:36 UTC' },
			{ label: 'Gemini Models · 5-hour', usedPercent: 2, resets: 'Nov 08, 2026, 08:29 UTC' },
			{ label: 'Claude and GPT models · Weekly', usedPercent: 100, resets: 'Nov 08, 2026, 10:06 UTC' },
			{ label: 'Claude and GPT models · 5-hour', usedPercent: 0, resets: 'Nov 08, 2026, 09:11 UTC' },
		]);
	});

	it('asks the language server of the agent program for the quota, and stops it afterwards', async () => {
		const { env, stop } = environment(summary);

		await quotaUsage(env).read(context(), signal);

		expect(env.startHub).toHaveBeenCalledWith('C:\\agy\\agy.exe', os.tmpdir());
		expect(env.call).toHaveBeenCalledWith(expect.anything(), 'RetrieveUserQuotaSummary', {});
		expect(stop).toHaveBeenCalledOnce();
	});

	it('waits for a freshly started language server to load the account', async () => {
		const { env } = environment(NOT_SIGNED_IN, NOT_SIGNED_IN, summary);

		const reading = await quotaUsage(env).read(context(), signal);

		expect(reading?.windows).toHaveLength(4);
		expect(env.call).toHaveBeenCalledTimes(3);
	});

	it('says why there is no quota when no Google account is signed in, and gives up waiting', async () => {
		const { env, stop } = environment(NOT_SIGNED_IN);

		const reading = await quotaUsage(env).read(context(), signal);

		expect(reading).toEqual({ windows: [], note: expect.stringContaining('signed-in Google account') });
		expect(vi.mocked(env.call).mock.calls.length).toBeGreaterThan(1);
		expect(vi.mocked(env.call).mock.calls.length).toBeLessThanOrEqual(40);
		expect(stop).toHaveBeenCalledOnce();
	});

	it('does not start the language server when an API key is in use', async () => {
		const { env } = environment(summary);

		const reading = await quotaUsage(env).read(context({}, 'AIza-key'), signal);

		expect(reading).toEqual({ windows: [], note: expect.stringContaining('API key') });
		expect(env.startHub).not.toHaveBeenCalled();
	});

	it('reads the quota of the account when the saved key is set aside for it', async () => {
		const { env } = environment(summary);

		const reading = await quotaUsage(env).read(context({ authPreference: 'oauth' }, 'AIza-key'), signal);

		expect(reading?.windows).toHaveLength(4);
	});

	it('surfaces other errors, and still stops the language server', async () => {
		const { env, stop } = environment(new Error('HTTP 403 permission denied'));

		await expect(quotaUsage(env).read(context(), signal)).rejects.toThrow('403');
		expect(env.call).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledOnce();
	});

	it.each([
		['no groups', { response: { groups: [] } }],
		['a fraction above 1', { response: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 1.5 }] }] } }],
		['no response', {}],
	])('does not take an answer with %s for a reading', async (_name, answer) => {
		const { env } = environment(answer);

		await expect(quotaUsage(env).read(context(), signal)).rejects.toThrow('quota');
	});

	it('stops waiting when the refresh is cancelled', async () => {
		const { env, stop } = environment(NOT_SIGNED_IN);
		const abort = new AbortController();
		vi.mocked(env.wait).mockImplementation(async () => { abort.abort(); });

		await expect(quotaUsage(env).read(context(), abort.signal)).rejects.toThrow();
		expect(env.call).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledOnce();
	});
});
