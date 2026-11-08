import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LastModelCall } from '../core/adapter';
import { APP_DATA_DIR } from './googleHub';

/** How much of the end of the record is read: enough for the last steps, whatever the tool output before them. */
const TAIL_BYTES = 256 * 1024;

/** Where `agy acp` writes the steps of a session, with the tokens of each model call. */
export function transcriptFile(sessionId: string, geminiHome: string = geminiHomeFromEnv()): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
		return undefined;
	}
	return path.join(geminiHome, APP_DATA_DIR, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

function geminiHomeFromEnv(): string {
	return process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
}

/**
 * The prompt and cache counts of the newest model call in a conversation record. `agy acp` reports
 * only the sums of a whole turn over ACP, so this is how the context of the last call is known.
 */
export async function lastModelCallOf(file: string): Promise<LastModelCall | undefined> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, 'r');
	} catch {
		return undefined;
	}
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		const lines = buffer.toString('utf8').split('\n');
		// The first line may be cut by the start of the read; the last may still be written.
		for (let index = lines.length - 1; index >= 0; index--) {
			const call = modelCallOf(lines[index]);
			if (call) {
				return call;
			}
		}
		return undefined;
	} finally {
		await handle.close();
	}
}

function modelCallOf(line: string): LastModelCall | undefined {
	const text = line.trim();
	if (!text.endsWith('}')) {
		return undefined;
	}
	let step: { type?: unknown; input_tokens?: unknown; cache_read_tokens?: unknown };
	try {
		step = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (step.type !== 'PLANNER_RESPONSE' || typeof step.input_tokens !== 'number') {
		return undefined;
	}
	const cached = typeof step.cache_read_tokens === 'number' ? step.cache_read_tokens : 0;
	return { promptTokens: step.input_tokens + cached, cachedTokens: cached };
}
