/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

export function shortHash(text: string): string {
	return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** The fingerprint of the text of an agent message, as the agent expects it in a fork point. */
export function messageFingerprintOf(text: string): string {
	return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
