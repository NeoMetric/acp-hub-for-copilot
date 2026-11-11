/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { characterCountOf } from '../../src/hosts/vscode/tokenCount';
import { assistant, image, toolCall, toolResult, user } from './messages';

describe('characterCountOf', () => {
	it('counts text, tool calls, tool results and images', () => {
		expect(characterCountOf(user('four'))).toBe(4);
		expect(characterCountOf(assistant('hi', toolCall('c1', 'run')))).toBe(2 + 'run'.length + '{}'.length);
		expect(characterCountOf(user(toolResult('c1')))).toBe('output'.length);
		expect(characterCountOf(user(image([1])))).toBeGreaterThan(1000);
	});
});
