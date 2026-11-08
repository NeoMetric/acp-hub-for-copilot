import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastModelCallOf, transcriptFile } from '../../../src/adapters/googleTranscript';

let temp: string;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acphub-google-transcript-é -'));
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

/** One conversation record, in the form `agy acp` writes it. */
function transcript(lines: readonly object[]): string {
	const file = path.join(temp, 'transcript.jsonl');
	fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
	return file;
}

const user = { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'do it' };
const call = (input: number, cached: number, output = 10, extra: object = {}) => ({
	step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: input, cache_read_tokens: cached, output_tokens: output, ...extra,
});

describe('lastModelCallOf', () => {
	it('reads the prompt and cache counts of the newest model call', async () => {
		const file = transcript([user, call(25423, 0), { type: 'GENERIC', content: 'command output' }, call(2191, 23558), call(2200, 23600)]);

		expect(await lastModelCallOf(file)).toEqual({ promptTokens: 25800, cachedTokens: 23600 });
	});

	it('ignores steps that are not model calls', async () => {
		const file = transcript([user, call(100, 900), { type: 'GENERIC', content: 'x' }]);

		expect(await lastModelCallOf(file)).toEqual({ promptTokens: 1000, cachedTokens: 900 });
	});

	it('skips a last line that was still being written', async () => {
		const file = transcript([call(2191, 23558)]);
		fs.appendFileSync(file, '{"step_index":3,"type":"PLANNER_RESPONSE","input_tok');

		expect(await lastModelCallOf(file)).toEqual({ promptTokens: 25749, cachedTokens: 23558 });
	});

	it('reads the end of a large record, not all of it', async () => {
		const big = { type: 'GENERIC', content: 'x'.repeat(20_000) };
		const file = transcript([...Array.from({ length: 40 }, () => big), call(2191, 23558)]);

		expect(await lastModelCallOf(file)).toEqual({ promptTokens: 25749, cachedTokens: 23558 });
	});

	it('is undefined with no record', async () => {
		expect(await lastModelCallOf(path.join(temp, 'missing.jsonl'))).toBeUndefined();
	});

	it('is undefined when the record holds no model call yet', async () => {
		const file = transcript([user, { type: 'GENERIC', content: 'x' }]);

		expect(await lastModelCallOf(file)).toBeUndefined();
	});
});

describe('transcriptFile', () => {
	it('is the record of the session under the gemini home', () => {
		expect(transcriptFile('abc-123', 'C:\\gemini')).toBe(path.join('C:\\gemini', 'antigravity-copilot', 'brain', 'abc-123', '.system_generated', 'logs', 'transcript.jsonl'));
	});

	it('refuses a session id that could point outside the folder', () => {
		expect(transcriptFile('../outside', 'C:\\gemini')).toBeUndefined();
		expect(transcriptFile('a/b', 'C:\\gemini')).toBeUndefined();
	});
});
