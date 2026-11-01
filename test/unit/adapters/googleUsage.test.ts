import { describe, expect, it } from 'vitest';
import type { UsageContext } from '../../../src/core/adapter';
import { googleAdapter } from '../../../src/adapters/google';

const signal = new AbortController().signal;
const usage = [
  '### Session Usage',
  '- Total: 0 tokens',
  '### Quota Limits',
  '- **Gemini Models**',
  '  *(Models within this group: Gemini Flash, Gemini Pro)*',
  '  - **Weekly Limit Remaining:** 75% remaining (resets Nov 08, 2026, 06:41 UTC)',
  '  - **Five Hour Limit Remaining:** 99% remaining (resets Nov 01, 2026, 11:41 UTC)',
  '- **Claude and GPT models**',
  '  - **Weekly Limit Remaining:** 100% remaining',
  '  - **Five Hour Limit Remaining:** 0% remaining',
].join('\n');

function context(reply: string | undefined): UsageContext {
  return { askAgent: async (prompt: string) => prompt === '/usage' ? reply : 'unexpected command' } as UsageContext;
}

describe('Google usage', () => {
  it('converts grouped remaining limits into sidebar usage windows', async () => {
    expect(googleAdapter.usage).toBeDefined();
    const reading = await googleAdapter.usage!.read(context(usage), signal);
    expect(reading?.windows).toEqual([
      { label: 'Gemini Models · Weekly', usedPercent: 25, resets: 'Nov 08, 2026, 06:41 UTC' },
      { label: 'Gemini Models · 5-hour', usedPercent: 1, resets: 'Nov 01, 2026, 11:41 UTC' },
      { label: 'Claude and GPT models · Weekly', usedPercent: 0, resets: undefined },
      { label: 'Claude and GPT models · 5-hour', usedPercent: 100, resets: undefined },
    ]);
  });

  it('reports non-subscription accounts as not applicable', async () => {
    const reading = await googleAdapter.usage!.read(context('### Quota Limits\n- Not applicable for current authentication method.'), signal);
    expect(reading?.windows).toEqual([]);
    expect(reading?.note).toBeTruthy();
  });

  it('surfaces quota errors rather than treating them as empty usage', async () => {
    await expect(googleAdapter.usage!.read(context('### Quota Limits\n- Unable to retrieve quota status (HTTP 403)'), signal)).rejects.toThrow();
  });

  it('does not treat an unrecognised or invalid response as a successful reading', async () => {
    await expect(googleAdapter.usage!.read(context('### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 101% remaining'), signal)).rejects.toThrow();
  });

  it('returns undefined when the agent is unavailable', async () => {
    expect(await googleAdapter.usage!.read(context(undefined), signal)).toBeUndefined();
  });
});
