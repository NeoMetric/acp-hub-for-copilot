/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The context sizes Codex's model catalog gives a model, already reduced by its effective-window percentage. */
export interface CatalogWindow {
	/** The window a session gets by default. */
	readonly normal: number;
	/** The most a `model_context_window` override can raise it to. */
	readonly max: number;
}

const DEFAULT_PERCENT = 95;

/**
 * Reads the model catalog Codex keeps in `CODEX_HOME`, by bare model slug. The catalog
 * is model metadata the adapter fetched; it holds no credentials. An absent or
 * unreadable file gives an empty map, and the picker then waits for the first turn.
 */
export function readModelCatalog(codexHome: string): ReadonlyMap<string, CatalogWindow> {
	try {
		return parseModelCatalog(JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8')));
	} catch {
		return new Map();
	}
}

export function parseModelCatalog(raw: unknown): ReadonlyMap<string, CatalogWindow> {
	const windows = new Map<string, CatalogWindow>();
	const models = (raw as { models?: unknown } | null)?.models;
	if (!Array.isArray(models)) {
		return windows;
	}

	for (const entry of models) {
		const model = entry as Record<string, unknown> | null;
		const slug = model?.slug;
		const size = positive(model?.context_window);
		if (typeof slug !== 'string' || size === undefined) {
			continue;
		}
		const percent = positive(model?.effective_context_window_percent) ?? DEFAULT_PERCENT;
		const effective = (tokens: number) => Math.floor(tokens * percent / 100);
		windows.set(slug, { normal: effective(size), max: effective(Math.max(size, positive(model?.max_context_window) ?? size)) });
	}
	return windows;
}

function positive(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
