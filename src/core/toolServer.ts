/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The name of the MCP server that carries the client's tools to an agent. Its tools reach the model as `mcp__hub__<name>` (Claude, Codex) and `mcp_hub_<name>` (Google). */
export const TOOL_SERVER_NAME = 'hub';

/** The one line an agent keeps as its identity when its own system prompt is replaced and the client sent no prompt. */
export const AGENT_BASE_IDENTITY = 'You are a coding agent working in the user\'s workspace.';
