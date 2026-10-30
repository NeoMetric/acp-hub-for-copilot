import type { UsageContext, UsageReading, UsageSource, UsageWindow } from '../core/adapter';

const PLAN_PATTERN = /^>\s*Claude (.+?) subscription usage\s*$/;
// `**5-hour limit** — **42%** · Resets Oct 20, 6:30 PM GMT+5:30`
const LIMIT_PATTERN = /^\*\*(.+?)\*\*\s+—\s+\*\*(\d+(?:\.\d+)?)%\*\*(?:\s+·\s+Resets\s+(.+?))?\s*$/;

function unescapeMarkdown(text: string): string {
	return text.replace(/\\([\\`*_[\]<>|])/g, '$1');
}

/** The short name shown for a limit; other limits keep the label the agent used. */
function displayLabel(label: string): string {
	if (/^5-hour/i.test(label)) {
		return '5-hour';
	}
	if (/^weekly\s+·\s+all models/i.test(label)) {
		return 'Weekly';
	}
	return label;
}

/**
 * Reads the limits section of the agent's `/usage` output. The agent only
 * hands that command out as Markdown, so this follows its "Limits" layout.
 */
export function parseUsageMarkdown(markdown: string): { plan?: string; windows: UsageWindow[] } {
	let plan: string | undefined;
	const windows: UsageWindow[] = [];

	for (const line of markdown.split(/\r?\n/)) {
		const planMatch = PLAN_PATTERN.exec(line);
		if (planMatch) {
			plan = planMatch[1].replace(/\\/g, '');
			continue;
		}

		const match = LIMIT_PATTERN.exec(line);
		if (!match) {
			continue;
		}
		windows.push({
			label: displayLabel(unescapeMarkdown(match[1])),
			usedPercent: Number(match[2]),
			resets: match[3] === undefined ? undefined : unescapeMarkdown(match[3]),
		});
	}

	return { plan, windows };
}

/**
 * Accounts billed per token (an API key or an Anthropic Console login) have no
 * plan limits: the agent then reports only the cost of the current session,
 * which is not an error.
 */
export function classifyUsageOutput(markdown: string): 'limits' | 'no-limits' | 'unrecognised' {
	const parsed = parseUsageMarkdown(markdown);
	const hasMainLimit = parsed.windows.some(window => window.label === '5-hour' || window.label === 'Weekly');
	if (hasMainLimit) {
		return 'limits';
	}
	return /^#{2,4}\s+This session\b/im.test(markdown) ? 'no-limits' : 'unrecognised';
}

/** Runs `/usage` on a warm session; the adapter answers it locally, so it costs no model call. */
export const claudeUsage: UsageSource = {
	async read(ctx: UsageContext): Promise<UsageReading | undefined> {
		const markdown = await ctx.askAgent('/usage');
		if (markdown === undefined) {
			return undefined;
		}

		const kind = classifyUsageOutput(markdown);
		if (kind === 'no-limits') {
			return { windows: [], note: 'This account is billed per token, so it has no 5-hour or weekly plan limits.' };
		}
		if (kind === 'unrecognised') {
			throw new Error('The agent reported no 5-hour or weekly limit for this account.');
		}
		return parseUsageMarkdown(markdown);
	},
};
