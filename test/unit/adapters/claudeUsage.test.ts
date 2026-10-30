import { describe, expect, it } from 'vitest';
import type { UsageContext } from '../../../src/core/adapter';
import { classifyUsageOutput, claudeUsage, parseUsageMarkdown } from '../../../src/adapters/claudeUsage';

// What the real adapter printed for an API-key profile.
const perToken = '## Usage\n\n---\n\n### This session\n\n| Cost | API time | Active |\n|:--|:--|:--|\n| $0.00 | 0s | 3s |\n';

function contextReplying(text: string | undefined): UsageContext {
	return { askAgent: () => Promise.resolve(text) } as unknown as UsageContext;
}

describe('classifyUsageOutput', () => {
	it('recognises plan limits', () => {
		expect(classifyUsageOutput('> Claude Max subscription usage\n\n**5-hour limit** — **42%**')).toBe('limits');
	});

	it('treats a session-only report as an account without plan limits', () => {
		expect(classifyUsageOutput(perToken)).toBe('no-limits');
	});

	it('does not call an unknown layout "no limits"', () => {
		expect(classifyUsageOutput('Something else entirely.')).toBe('unrecognised');
		expect(classifyUsageOutput('')).toBe('unrecognised');
	});

	it('prefers the limits when both appear', () => {
		expect(classifyUsageOutput(`**5-hour limit** — **1%**\n\n${perToken}`)).toBe('limits');
	});
});

describe('parseUsageMarkdown', () => {
	it('reads the plan and the 5-hour and weekly limits', () => {
		const parsed = parseUsageMarkdown([
			'> Claude Max 5x subscription usage',
			'',
			'**5-hour limit** — **42%** · Resets Oct 20, 6:30 PM GMT+5:30',
			'**Weekly · All models** — **17.5%** · Resets Oct 24, 9:00 AM GMT+5:30',
			'',
		].join('\n'));

		expect(parsed.plan).toBe('Max 5x');
		expect(parsed.windows).toEqual([
			{ label: '5-hour', usedPercent: 42, resets: 'Oct 20, 6:30 PM GMT+5:30' },
			{ label: 'Weekly', usedPercent: 17.5, resets: 'Oct 24, 9:00 AM GMT+5:30' },
		]);
	});

	it('keeps per-model windows after the main ones', () => {
		const parsed = parseUsageMarkdown(['**5-hour limit** — **1%**', '**Weekly · Opus** — **60%** · Resets Oct 24'].join('\r\n'));

		expect(parsed.windows[0].resets).toBeUndefined();
		expect(parsed.windows[1]).toEqual({ label: 'Weekly · Opus', usedPercent: 60, resets: 'Oct 24' });
	});

	it('unescapes Markdown escapes in labels and reset times', () => {
		const parsed = parseUsageMarkdown('**Weekly · Claude\\_Design** — **9%** · Resets Oct 20 \\*soon\\*');

		expect(parsed.windows).toEqual([{ label: 'Weekly · Claude_Design', usedPercent: 9, resets: 'Oct 20 *soon*' }]);
	});

	it('returns nothing for output it does not recognise', () => {
		expect(parseUsageMarkdown('Something else entirely.\n\nNo limits here.')).toEqual({ plan: undefined, windows: [] });
	});
});

describe('claudeUsage.read', () => {
	const signal = new AbortController().signal;

	it('returns the windows of a plan account', async () => {
		const reading = await claudeUsage.read(contextReplying('**5-hour limit** — **42%**'), signal);
		expect(reading?.windows).toEqual([{ label: '5-hour', usedPercent: 42, resets: undefined }]);
	});

	it('explains an account billed per token', async () => {
		const reading = await claudeUsage.read(contextReplying(perToken), signal);
		expect(reading?.windows).toEqual([]);
		expect(reading?.note).toContain('billed per token');
	});

	it('is unavailable when the agent is not set up', async () => {
		expect(await claudeUsage.read(contextReplying(undefined), signal)).toBeUndefined();
	});

	it('fails on a layout it does not know', async () => {
		await expect(claudeUsage.read(contextReplying('nope'), signal)).rejects.toThrow('no 5-hour or weekly limit');
	});
});
