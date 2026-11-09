/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

/** The guidance helpers live in the engine now; every existing import site keeps working. */
export { MAX_TURN_FAILURES, keepsSessionAfterFailure, guidanceDiffers, guidanceHashOf, guidanceLineHashes, guidanceChangeOf, mergeGuidanceChange, toolChangeOf, describeToolChange } from '../../engine/chat/keys';

/** The chat identity is scraped from the host's own prompt, which lives in the host now. */
export { chatContextOf, chatIdOf, chatLabelOf, sessionKey } from '../../hosts/vscode/identity';

/**
 * Whether the host now offers a different set of tools than the session has.
 * An agent that does not refresh its tool list on `tools/list_changed` reads it
 * once, when its session opens, so such a change only reaches it by reopening the session.
 */
export function toolsDiffer(opened: ReadonlySet<string>, tools: readonly vscode.LanguageModelChatTool[]): boolean {
	return tools.length !== opened.size || tools.some(tool => !opened.has(tool.name));
}
