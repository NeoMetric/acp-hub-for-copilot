/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One event of a turn, as the engine streams it and the host renders it. */
export type StreamEvent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'thought'; readonly text: string }
	| { readonly type: 'tool-call'; readonly callId: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'usage'; readonly promptTokens: number; readonly cachedTokens: number; readonly outputTokens: number; readonly reasoningTokens?: number }
	/** `stopReason` is the agent's own reason for ending the turn, such as `end_turn`. */
	| { readonly type: 'done'; readonly stopReason: string }
	| { readonly type: 'error'; readonly message: string };
