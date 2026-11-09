import { expect, it } from 'vitest';
import { messageFingerprintOf } from '../../src/core/sessionFingerprint';
import { messageFingerprintOf as fromStore } from '../../src/core/sessionStore';

it('the adapter-facing fingerprint is the session store fingerprint', () => {
	expect(messageFingerprintOf('one\n\ntwo')).toBe(fromStore('one\n\ntwo'));
	expect(messageFingerprintOf('')).toHaveLength(71);
});
