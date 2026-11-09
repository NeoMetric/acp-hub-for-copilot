/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, it } from 'vitest';
import { RpcError } from '../../src/core/protocol';

it('RpcError keeps its code and message', () => {
	const error = new RpcError('Authentication required', -32000);
	expect(error.code).toBe(-32000);
	expect(error.message).toBe('Authentication required');
	expect(error).toBeInstanceOf(Error);
});
