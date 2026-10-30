/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Log } from './logging';
import { describeRequest } from './requestContext';

/** Dumps kept on disk; older ones are removed. */
const MAX_DUMPS = 40;

/** One line saying what a request carried: roles, text sizes and the tags in them. */
export function summarizeRequest(messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions): string {
	const description = describeRequest(messages, options, { previewLength: 0 });
	const parts = description.messages.map(message => {
		const text = message.parts.filter(part => part.kind === 'text');
		const chars = text.reduce((total, part) => total + part.chars, 0);
		const tags = [...new Set(text.flatMap(part => part.tags))];
		const others = message.parts.filter(part => part.kind !== 'text').map(part => part.kind);
		return `#${message.index} role ${message.role} ${chars}ch${tags.length ? ` <${tags.join('><')}>` : ''}${others.length ? ` +${others.join(',')}` : ''}`;
	});
	const modelOptions = Object.entries(description.options.modelOptions).map(([key, value]) => `${key}=${value}`).join(' ');
	return `${parts.join(' | ')} || modelOptions: ${modelOptions || 'none'}`;
}

/**
 * Writes each request Copilot sends to a JSON file while the
 * `acpHub.debug.dumpRequests` setting is on, so what reaches the provider
 * can be read rather than guessed. The files hold the whole prompt, so they
 * stay on this machine and the setting is off by default.
 */
export function createRequestDump(directory: vscode.Uri, log: Log): (key: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions) => void {
	let announced = false;

	return (key, messages, options) => {
		if (!vscode.workspace.getConfiguration('acpHub').get<boolean>('debug.dumpRequests', false)) {
			return;
		}
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const file = path.join(directory.fsPath, `${stamp}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}.json`);
		const body = JSON.stringify({ key, ...describeRequest(messages, options, { previewLength: Infinity }) }, undefined, 2);

		void (async () => {
			try {
				await fs.mkdir(directory.fsPath, { recursive: true });
				await fs.writeFile(file, body, 'utf8');
				if (!announced) {
					announced = true;
					log(`Dumping each request to ${directory.fsPath} (setting acpHub.debug.dumpRequests).`);
				}
				const old = (await fs.readdir(directory.fsPath)).filter(name => name.endsWith('.json')).sort();
				await Promise.all(old.slice(0, Math.max(0, old.length - MAX_DUMPS)).map(name => fs.rm(path.join(directory.fsPath, name), { force: true })));
			} catch (error) {
				log(`Could not dump the request: ${error instanceof Error ? error.message : String(error)}`, 'warn');
			}
		})();
	};
}
