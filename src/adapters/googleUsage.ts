import * as os from 'node:os';
import type { UsageReading, UsageSource, UsageWindow } from '../core/adapter';
import { callHub, startHub, type Hub } from './googleHub';
import { stringSetting } from './settingValues';

/** A language server just started needs a few seconds to load the account; this waits up to 15 s. */
const SIGN_IN_ATTEMPTS = 30;
const SIGN_IN_RETRY_MS = 500;
const NOT_SIGNED_IN = /not logged into Antigravity/i;

const RESET_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

interface QuotaBucket {
	displayName?: string;
	window?: string;
	remainingFraction?: number;
	resetTime?: string;
}

interface QuotaSummary {
	response?: { groups?: Array<{ displayName?: string; buckets?: QuotaBucket[] }> };
}

/** What reading the quota needs from the machine; tests replace it. */
export interface QuotaEnvironment {
	startHub(agy: string, cwd: string): Promise<Hub>;
	call(hub: Hub, method: string, body: object): Promise<unknown>;
	wait(ms: number): Promise<void>;
}

const realEnvironment: QuotaEnvironment = {
	startHub,
	call: callHub,
	wait: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

function labelOf(bucket: QuotaBucket): string {
	if (bucket.window === 'weekly') {
		return 'Weekly';
	}
	if (bucket.window === '5h') {
		return '5-hour';
	}
	return bucket.displayName ?? bucket.window ?? 'Limit';
}

function resetsOf(resetTime: string | undefined): string | undefined {
	const time = resetTime ? Date.parse(resetTime) : NaN;
	return Number.isFinite(time) ? `${RESET_FORMAT.format(time)} UTC` : undefined;
}

function windowsOf(summary: QuotaSummary): UsageWindow[] {
	const windows: UsageWindow[] = [];
	for (const group of summary.response?.groups ?? []) {
		for (const bucket of group.buckets ?? []) {
			const remaining = bucket.remainingFraction;
			if (typeof remaining !== 'number' || remaining < 0 || remaining > 1) {
				throw new Error('The Antigravity CLI returned an invalid quota.');
			}
			windows.push({ label: `${group.displayName ?? 'Models'} · ${labelOf(bucket)}`, usedPercent: Math.round((1 - remaining) * 100), resets: resetsOf(bucket.resetTime) });
		}
	}
	if (windows.length === 0) {
		throw new Error('The Antigravity CLI did not return a quota.');
	}
	return windows;
}

/**
 * Reads the account's quota from the Antigravity CLI's language server (`RetrieveUserQuotaSummary`),
 * started for this read and stopped afterwards. It costs no model call.
 */
export function quotaUsage(environment: QuotaEnvironment = realEnvironment): UsageSource {
	return {
		async read(ctx, signal): Promise<UsageReading> {
			const { launch } = ctx;
			if (launch.apiKey && stringSetting(launch.settings, 'authPreference', 'auto') !== 'oauth') {
				return { windows: [], note: 'Quota limits are reported for a signed-in Google account, not for an API key.' };
			}
			// Reading the quota needs no workspace; the temp folder always exists.
			const hub = await environment.startHub(launch.entryPath, os.tmpdir());
			try {
				for (let attempt = 1; ; attempt++) {
					try {
						return { windows: windowsOf(await environment.call(hub, 'RetrieveUserQuotaSummary', {}) as QuotaSummary) };
					} catch (error) {
						if (!NOT_SIGNED_IN.test(error instanceof Error ? error.message : String(error))) {
							throw error;
						}
						if (attempt >= SIGN_IN_ATTEMPTS) {
							return { windows: [], note: 'Quota limits are shown once a signed-in Google account is in use.' };
						}
					}
					await environment.wait(SIGN_IN_RETRY_MS);
					signal.throwIfAborted();
				}
			} finally {
				await hub.stop();
			}
		},
	};
}

export const googleUsage = quotaUsage();
