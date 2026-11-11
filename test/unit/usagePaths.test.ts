/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentsRoot, usageRoot } from '../../src/engine/store/paths';

describe('the store folders', () => {
	it('keeps the usage tallies in a folder of their own under the store root', () => {
		expect(usageRoot('/store')).toBe(path.join(path.resolve('/store'), 'usage'));
		expect(usageRoot('/store')).not.toBe(agentsRoot('/store'));
	});
});
