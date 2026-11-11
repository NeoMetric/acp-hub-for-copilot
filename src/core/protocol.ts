/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The ACP protocol types live in the engine so both hosts can name them. This
 * file stays because the adapters import them from `core`, and the adapter
 * boundary allows only the modules it lists.
 */
export * from '../engine/acp/protocol';
