/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The state key that remembers which providers were last written to the CLI's `providers.json`. */
export const CLI_PROVIDERS_KEY = 'server.cliProviders';

/** The provider an earlier version of this server registered; its entries are replaced too. */
const LEGACY_PROVIDER = 'acp-hub';

/** The Copilot CLI's provider file: `COPILOT_PROVIDERS_CONFIG`, or `providers.json` in its folder in the home folder. */
export function copilotProvidersFile(): string {
	return process.env.COPILOT_PROVIDERS_CONFIG?.trim() || path.join(os.homedir(), '.copilot', 'providers.json');
}

/** The reasoning-effort levels the Copilot CLI recognizes in a model's `capabilities.supports.reasoning_effort`. */
export const CLI_EFFORT_LEVELS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** One agent as the Copilot CLI lists it: the provider name and the models under it. */
export interface CliProvider {
	readonly name: string;
	/** `efforts` are the levels the model offers; the CLI's `/model` picker steps through them with the arrow keys. */
	readonly models: ReadonlyArray<{
		readonly name: string;
		readonly wireModel: string;
		readonly efforts?: readonly string[];
		/** The room the server reports for the model; without it the CLI assumes a small default window and compacts early. */
		readonly maxInputTokens?: number;
		readonly maxOutputTokens?: number;
	}>;
}

type JsonObject = Record<string, unknown>;

/**
 * Registers the agents in the Copilot CLI's `providers.json`. Entries this
 * server wrote before (`previous`) are replaced, and every other entry is kept.
 * A file that is not JSON is refused and left as it was.
 */
export function writeCliProviders(options: {
	file: string;
	baseUrl: string;
	token: string | undefined;
	providers: readonly CliProvider[];
	previous: readonly string[];
}): { written: string[] } {
	const { file } = options;
	const config = readConfig(file);
	// The names about to be written count as ours too: the remembered list is lost with the window's state, and the CLI refuses a name that appears twice.
	const ours = new Set([...options.previous, LEGACY_PROVIDER, ...options.providers.map(provider => provider.name)]);
	const providers = arrayOf(config.providers).filter(entry => !ours.has(String((entry as JsonObject)?.name)));
	const models = arrayOf(config.models).filter(entry => !ours.has(String((entry as JsonObject)?.provider)));
	const taken = new Set(models.map(entry => String((entry as JsonObject)?.id)));

	for (const provider of options.providers) {
		providers.push({
			name: provider.name,
			type: 'openai',
			baseUrl: options.baseUrl,
			...(options.token ? { bearerToken: options.token } : {}),
		});
		for (const model of provider.models) {
			const id = uniqueId(model.name.replace(/[\s/]+/g, '-'), taken);
			taken.add(id);
			const supports = model.efforts?.length ? { reasoning_effort: [...model.efforts] } : undefined;
			const limits = limitsOf(model.maxInputTokens, model.maxOutputTokens);
			models.push({
				id,
				provider: provider.name,
				wireModel: model.wireModel,
				...(supports || limits ? { capabilities: { ...(supports ? { supports } : {}), ...(limits ? { limits } : {}) } } : {}),
			});
		}
	}

	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ ...config, providers, models }, null, 2)}\n`, 'utf8');
	return { written: options.providers.map(provider => provider.name) };
}

/**
 * Sets the `displayName` VS Code shows for each vendor named in `names`, in the
 * extension's `package.json`; the indentation and line endings are kept. Answers
 * whether the file changed, since only a change needs a window reload.
 */
export function writeVendorNames(options: { packageJson: string; names: Readonly<Record<string, string>> }): boolean {
	const text = withoutBom(fs.readFileSync(options.packageJson, 'utf8'));
	const manifest = JSON.parse(text) as JsonObject;
	const contributes = manifest.contributes as { languageModelChatProviders?: Array<{ vendor?: string; displayName?: string }> } | undefined;
	let changed = false;
	for (const entry of contributes?.languageModelChatProviders ?? []) {
		const name = entry.vendor === undefined ? undefined : options.names[entry.vendor];
		if (name !== undefined && entry.displayName !== name) {
			entry.displayName = name;
			changed = true;
		}
	}
	if (!changed) {
		return false;
	}
	const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '\t';
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const body = JSON.stringify(manifest, null, indent).replace(/\n/g, eol);
	fs.writeFileSync(options.packageJson, text.endsWith('\n') ? `${body}${eol}` : body, 'utf8');
	return true;
}

/** The CLI's `capabilities.limits`: the window is the prompt and the output together, as the model picker counts it. */
function limitsOf(maxInput: number | undefined, maxOutput: number | undefined): JsonObject | undefined {
	if (!maxInput || maxInput <= 0 || !maxOutput || maxOutput <= 0) {
		return undefined;
	}
	return { max_context_window_tokens: maxInput + maxOutput, max_prompt_tokens: maxInput, max_output_tokens: maxOutput };
}

function readConfig(file: string): JsonObject {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {};
		}
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(withoutBom(text));
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed as JsonObject;
		}
	} catch {
		// Reported below, with the file's name.
	}
	throw new Error(`${file} is not a JSON object, so it was left as it is; fix or remove it and sync again.`);
}

/** Windows tools often save JSON with a byte order mark, which `JSON.parse` refuses; the rewrite drops it. */
function withoutBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? [...value] : [];
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
	let id = base;
	for (let suffix = 2; taken.has(id); suffix++) {
		id = `${base}-${suffix}`;
	}
	return id;
}
