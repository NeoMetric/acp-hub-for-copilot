import type { UsageSource, UsageWindow } from '../core/adapter';

const LIMIT = /^\*\*(.+?limit):\*\*\s+(\d+(?:\.\d+)?)% left(?:\s+\(resets (.+?)\))?\s*$/i;

function labelOf(label: string): string {
	return label.replace(/^codex (?=(?:5h|weekly) limit$)/i, '').replace(/\b5h limit$/i, '5-hour').replace(/\bweekly limit$/i, 'Weekly');
}

export const codexUsage: UsageSource = {
	async read(ctx) {
		const status = await ctx.askAgent('/status');
		if (status === undefined) {
			return undefined;
		}
		const windows: UsageWindow[] = [];
		for (const line of status.split(/\r?\n/)) {
			const match = LIMIT.exec(line.trim());
			if (!match) {
				continue;
			}
			const remaining = Number(match[2]);
			if (remaining < 0 || remaining > 100) {
				throw new Error('The Codex agent returned an invalid rate-limit percentage.');
			}
			windows.push({ label: labelOf(match[1]), usedPercent: 100 - remaining, resets: match[3] });
		}
		if (windows.length > 0) {
			return { windows };
		}
		if (/^\*\*Account:\*\* API key configured\s*$/m.test(status)) {
			return { windows: [], note: 'This Codex account has no ChatGPT plan limits (an API key is billed per token).' };
		}
		throw new Error('The Codex agent did not return rate limits.');
	},
};
