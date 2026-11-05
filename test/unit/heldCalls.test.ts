import { describe, expect, it, vi } from 'vitest';
import { resolveToolResults } from '../../src/core/provider/heldCalls';
import type { ActiveTurn } from '../../src/core/provider/types';
import { assistant, toolCall, user } from './messages';
import { LanguageModelTextPart, LanguageModelToolResultPart } from './vscode-mock';

describe('tool result continuation', () => {
	it('delivers separate skill context with the tool result without duplicating it', () => {
		for (const alreadyIncluded of [false, true]) {
			const context = '<skill-context name="test">instructions</skill-context>';
			const content = alreadyIncluded ? [new LanguageModelTextPart(context)] : [new LanguageModelTextPart('loaded')];
			const result = new LanguageModelToolResultPart('1', content);
			let received: readonly unknown[] = [];
			const turn = { pending: new Map([['1', { resolve: (parts: readonly unknown[]) => { received = parts; }, reject: vi.fn() }]]), streaming: false } as unknown as ActiveTurn;
			resolveToolResults(turn, [assistant(toolCall('1', 'skill')), user(result), user(context)], vi.fn());
			expect(received.filter(part => part instanceof LanguageModelTextPart && part.value === context)).toHaveLength(1);
		}
	});
});
