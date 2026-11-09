/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface AcpMcpHttpServer {
	readonly type: 'http';
	readonly name: string;
	readonly url: string;
	readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface AcpConfigOptionChoice {
	readonly value: string;
	readonly name: string;
	readonly description?: string | null;
}

export interface AcpConfigOptionGroup {
	readonly group: string;
	readonly options: ReadonlyArray<AcpConfigOptionChoice>;
}

export interface AcpConfigOption {
	readonly id: string;
	readonly name: string;
	readonly description?: string | null;
	readonly category?: string | null;
	readonly type: string;
	readonly currentValue?: string | boolean;
	readonly options?: ReadonlyArray<AcpConfigOptionChoice | AcpConfigOptionGroup>;
}

/** One entry of ACP's own model catalogue, whose ids may carry the effort as model[effort]. */
export interface AcpModelInfo {
	readonly modelId?: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AcpModels {
	readonly availableModels?: readonly AcpModelInfo[];
	readonly currentModelId?: string;
}

/** A sign-in method the agent advertised in `initialize`. */
export interface AcpAuthMethod {
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AgentSession {
	readonly sessionId: string;
	configOptions: readonly AcpConfigOption[];
	/** The model catalogue the agent reported with this session, if it did. */
	readonly models?: AcpModels;
}

/** Where in a stored conversation a fork is taken: after one agent message, named by id and by what it said. */
export interface ForkPoint {
	readonly messageId: string;
	/** `sha256:<hex>` of the message's text, for an agent that no longer knows the id. */
	readonly messageFingerprint: string;
	/** Which of the messages with that fingerprint is meant, counting from 1. */
	readonly messageOccurrence: number;
}

/** Token counts of one turn, as reported by the agent. */
export interface AcpTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedReadTokens: number;
	readonly cachedWriteTokens: number;
	readonly totalTokens: number;
	readonly reasoningOutputTokens?: number;
}

/** A text content block as defined by ACP. */
export interface AcpTextBlock {
	readonly type: 'text';
	readonly text: string;
}

/** An image content block as defined by ACP; `data` is base64 encoded. */
export interface AcpImageBlock {
	readonly type: 'image';
	readonly data: string;
	readonly mimeType: string;
}

export type AcpContentBlock = AcpTextBlock | AcpImageBlock;

/** An error returned by the peer, carrying the JSON-RPC code and payload. */
export class RpcError extends Error {

	constructor(message: string, readonly code: number, readonly data?: unknown) {
		super(message);
		this.name = "RpcError";
	}
}
