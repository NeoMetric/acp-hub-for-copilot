import { describe, expect, it } from 'vitest';
import type { UsageContext } from '../../../src/core/adapter';
import { codexAdapter } from '../../../src/adapters/codex';

const signal = new AbortController().signal;
const status = [
  '**Model:** example',
  '**Account:** ChatGPT Plus',
  '**5h limit:** 58% left (resets 12:30)',
  '**Weekly limit:** 93% left (resets 10:15 on Nov 08)',
].join('  \n');

function context(reply: string | undefined): UsageContext {
  return { askAgent: async (prompt: string) => prompt === '/status' ? reply : 'unexpected command' } as UsageContext;
}

describe('Codex usage through ACP status', () => {
  it('converts status limits and reset times to sidebar windows', async () => {
    const reading = await codexAdapter.usage!.read(context(status), signal);
    expect(reading?.windows).toEqual([
      { label: '5-hour', usedPercent: 42, resets: '12:30' },
      { label: 'Weekly', usedPercent: 7, resets: '10:15 on Nov 08' },
    ]);
  });

  it('keeps the primary Codex labels while distinguishing model-specific limits', async () => {
    const reading = await codexAdapter.usage!.read(context([
      '**codex 5h limit:** 72% left',
      '**codex Weekly limit:** 88% left',
      '**Codex Spark 5h limit:** 50% left',
    ].join('\n')), signal);
    expect(reading?.windows.map(window => window.label)).toEqual(['5-hour', 'Weekly', 'Codex Spark 5-hour']);
  });

  it('explains an API key account without plan limits', async () => {
    const reading = await codexAdapter.usage!.read(context('**Account:** API key configured\n**Limits:** data not available yet'), signal);
    expect(reading?.windows).toEqual([]);
    expect(reading?.note).toContain('API key');
  });

  it('fails when signed-in account limits are unavailable', async () => {
    await expect(codexAdapter.usage!.read(context('**Account:** ChatGPT Plus\n**Limits:** data not available yet'), signal)).rejects.toThrow();
  });

  it('returns undefined when the agent is unavailable', async () => {
    expect(await codexAdapter.usage!.read(context(undefined), signal)).toBeUndefined();
  });
});
