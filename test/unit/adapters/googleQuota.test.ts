import { describe, expect, it } from 'vitest';
import { describeTier, formatReset, mapQuotaError, parseQuotaError, QuotaLimitError } from '../../../src/adapters/googleQuota';
import { RpcError } from '../../../src/core/rpc';

const NOW = Date.parse('2026-10-21T10:00:00Z');

describe('parseQuotaError', () => {
	it('ignores errors that are not about a usage limit', () => {
		expect(parseQuotaError(new Error('quota'), NOW)).toBeUndefined();
		expect(parseQuotaError(new RpcError('Internal error', -32603, { details: 'SSL EOF' }), NOW)).toBeUndefined();
	});

	it('recognises a limit error without a reset time', () => {
		expect(parseQuotaError(new RpcError('Resource exhausted', -32603), NOW)).toEqual({ message: 'Resource exhausted', resetAt: undefined });
	});

	it('reads an ISO reset time from the error data', () => {
		const error = new RpcError('Quota exceeded', -32603, { details: 'weekly quota, resetTime 2026-10-21T14:30:00Z' });
		expect(parseQuotaError(error, NOW)?.resetAt).toBe(Date.parse('2026-10-21T14:30:00Z'));
	});

	it('reads a worded duration and a retry delay', () => {
		expect(parseQuotaError(new RpcError('Rate limit reached, resets in 4h 12m', -32603), NOW)?.resetAt).toBe(NOW + (4 * 60 + 12) * 60_000);
		expect(parseQuotaError(new RpcError('429', -32603, { retryDelay: '3600s', status: 'RESOURCE_EXHAUSTED' }), NOW)?.resetAt).toBe(NOW + 3_600_000);
	});

	it('ignores a reset time that is already past', () => {
		expect(parseQuotaError(new RpcError('Quota exceeded 2026-10-21T08:00:00Z', -32603), NOW)?.resetAt).toBeUndefined();
	});
});

describe('mapQuotaError', () => {
	it('turns a quota error into a QuotaLimitError that keeps the original as its cause', () => {
		const original = new RpcError('Resource exhausted', -32603);
		const mapped = mapQuotaError(original);

		expect(mapped).toBeInstanceOf(QuotaLimitError);
		expect(mapped?.message).toBe('Your Antigravity usage limit is reached. Try again later.');
		expect(mapped?.cause).toBe(original);
	});

	it('keeps any other error as it is', () => {
		expect(mapQuotaError(new RpcError('Internal error', -32603))).toBeUndefined();
		expect(mapQuotaError(new Error('quota'))).toBeUndefined();
	});
});

describe('formatReset', () => {
	it('words the time left', () => {
		expect(formatReset(NOW + 12 * 60_000, NOW)).toBe('in 12m');
		expect(formatReset(NOW + (4 * 60 + 12) * 60_000, NOW)).toBe('in 4h 12m');
		expect(formatReset(NOW + (2 * 24 + 3) * 3_600_000, NOW)).toBe('in 2d 3h');
		expect(formatReset(NOW - 1, NOW)).toBe('now');
	});
});

describe('QuotaLimitError', () => {
	it('says when the limit resets, or just that it is reached', () => {
		expect(new QuotaLimitError({ message: 'x', resetAt: NOW + 3_600_000 }, NOW).message).toBe('Your Antigravity usage limit is reached. It resets in 1h 0m.');
		expect(new QuotaLimitError({ message: 'x' }, NOW).message).toBe('Your Antigravity usage limit is reached. Try again later.');
	});
});

describe('describeTier', () => {
	it('reads a string or a named object', () => {
		expect(describeTier(' Pro ')).toBe('Pro');
		expect(describeTier({ name: 'Ultra' })).toBe('Ultra');
		expect(describeTier(true)).toBeUndefined();
		expect(describeTier(undefined)).toBeUndefined();
	});
});
