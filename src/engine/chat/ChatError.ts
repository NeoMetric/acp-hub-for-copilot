/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A failure the user must see. The engine cannot build the host's own error
 * type, so it throws this and the host turns the message into whatever it
 * shows the chat.
 */
export class ChatError extends Error {

	constructor(message: string) {
		super(message);
		this.name = 'ChatError';
	}
}
