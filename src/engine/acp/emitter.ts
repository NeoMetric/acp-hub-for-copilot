/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A resource that must be released; the engine's stand-in for `vscode.Disposable`. */
export class Disposable {

	/** Releases the resource; the emitter binds this to the listener it registered. */
	readonly dispose: () => void;

	constructor(dispose: () => void = () => { }) {
		this.dispose = dispose;
	}
}

type Listener<T> = (value: T) => unknown;

/** Fires one event to every listener; the engine's stand-in for `vscode.EventEmitter`. */
export class Emitter<T> {

	private readonly listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>): Disposable => {
		this.listeners.add(listener);
		return new Disposable(() => this.listeners.delete(listener));
	};

	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

/**
 * The part of a host's cancellation token the engine observes. A host's own
 * token satisfies it structurally, so no host type has to reach the engine.
 */
export interface CancellationToken {

	readonly isCancellationRequested: boolean;

	onCancellationRequested(listener: () => unknown): { dispose(): void };
}
