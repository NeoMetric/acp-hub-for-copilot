import type { UsageSource, UsageWindow } from '../core/adapter';

const GROUP = /^- \*\*(.+?)\*\*\s*$/;
const LIMIT = /^\s+- \*\*(.+?):\*\*\s+(\d+(?:\.\d+)?)% remaining(?:\s+\(resets (.+?)\))?\s*$/;

function labelOf(label: string): string {
	if (/^weekly limit remaining$/i.test(label)) {
		return 'Weekly';
	}
	if (/^five hour limit remaining$/i.test(label)) {
		return '5-hour';
	}
	return label;
}

export const googleUsage: UsageSource = {
	async read(ctx) {
		const markdown = await ctx.askAgent('/usage');
		if (markdown === undefined) {
			return undefined;
		}
		const section = markdown.split(/^### Quota Limits\s*$/m)[1]?.split(/^###\s/m)[0];
		if (!section) {
			throw new Error('The Antigravity agent returned an unrecognised quota report.');
		}
		if (/^- Not applicable for current authentication method\./m.test(section)) {
			return { windows: [], note: 'Quota limits are not applicable for this authentication method.' };
		}
		if (/^- No quota limits reported\./m.test(section)) {
			return { windows: [], note: 'This account has no reported quota limits.' };
		}

		const windows: UsageWindow[] = [];
		let group: string | undefined;
		for (const line of section.split(/\r?\n/)) {
			const groupMatch = GROUP.exec(line);
			if (groupMatch) {
				group = groupMatch[1];
				continue;
			}
			const match = LIMIT.exec(line);
			if (!match || !group) {
				continue;
			}
			const remaining = Number(match[2]);
			if (remaining < 0 || remaining > 100) {
				throw new Error('The Antigravity agent returned an invalid quota percentage.');
			}
			windows.push({ label: `${group} · ${labelOf(match[1])}`, usedPercent: 100 - remaining, resets: match[3] });
		}
		if (windows.length === 0) {
			throw new Error('The Antigravity agent did not return quota limits.');
		}
		return { windows };
	},
};
