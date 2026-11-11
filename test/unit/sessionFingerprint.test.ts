import { expect, it } from 'vitest';
import { messageFingerprintOf } from '../../src/engine/chat/sessionFingerprint';
import { messageFingerprintOf as fromStore } from '../../src/engine/chat/sessionStore';

it('the adapter-facing fingerprint is the session store fingerprint', () => {
	expect(messageFingerprintOf('one\n\ntwo')).toBe(fromStore('one\n\ntwo'));
	expect(messageFingerprintOf('')).toHaveLength(71);
});
