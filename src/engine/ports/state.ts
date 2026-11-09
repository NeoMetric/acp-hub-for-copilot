/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The key/value state the engine persists. The host decides where it lives,
 * and both hosts share one store, so a chat saved by one resumes in the other.
 */
export interface StateStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Promise<void>;
	keys(): readonly string[];
}

/** The credentials of the agents, by the id the agent knows them under. */
export interface SecretStore {
	get(id: string): Promise<string | undefined>;
	set(id: string, value: string): Promise<void>;
	delete(id: string): Promise<void>;
}

/** The settings of an agent, as the host's own configuration holds them. */
export interface ConfigReader {
	get<T>(section: string): T | undefined;
}
