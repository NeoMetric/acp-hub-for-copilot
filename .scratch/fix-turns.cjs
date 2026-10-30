const fs = require('node:fs');
const file = 'src/core/provider/turns.ts';
let t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const imports = `import * as vscode from 'vscode';
import type { AgentAdapter } from '../adapter';
import type { AcpSessionUpdate, AcpTokenUsage } from '../agentClient';
import type { RequestMeasurement } from '../cache';
import type { AcpContentBlock } from '../convert';
import type { Log } from '../logging';
import { RpcConnectionClosedError } from '../rpc';
import type { SavedSessionStore } from '../sessionStore';
import { CANCELLED_TOOL_CALL, clearToolDeadline, disposeCancellations, failPendingToolCalls, releaseHeldToolCalls, sleepUntilActivity, trackCancellation, wakeTurn, watchToolCalls } from './heldCalls';
import { keepsSessionAfterFailure } from './keys';
import type { ModelList } from './modelList';
import { rememberSession } from './reuse';
import { describe } from './sessionOptions';
import type { ActiveTurn, AgentApi, ChatSession, FinishedTurn } from './types';
import { addModelCall, logCache, logReuseVerdict, reportUsage, warnIfCallsMissing } from './usageReport';

/**
 * How long to collect tool calls before handing a turn back to Copilot, so
 * calls the agent issued in parallel travel in the same response.
 */
const PARALLEL_TOOL_WINDOW_MS = 250;
/** How long to wait for an abandoned turn to end before moving on. */
const ABANDONED_TURN_WAIT_MS = 5_000;

/** What the turns need from the provider that owns them. */
export interface TurnHost {
	adapter: AgentAdapter;
	log: Log;
	models: ModelList;
	saved: SavedSessionStore;
	agent(): AgentApi;
	finished(turn: FinishedTurn): void;
	measured(measurement: RequestMeasurement): void;
	destroySession(key: string): Promise<void>;
	isSignInRequired(error: unknown): boolean;
	promptSignIn(): void;
	needsCredentials(): string;
}`;
t = t.replace('@@IMPORTS@@', imports);
t = t.replace('\tconstructor(private readonly host: TurnHost) { }\n', `\tconstructor(private readonly host: TurnHost) { }

	private get log(): Log {
		return this.host.log;
	}

	private get agent(): AgentApi {
		return this.host.agent();
	}

	/** Whether the agent reports the usage of each model call, not only of the turn. */
	private get reportsEachModelCall(): boolean {
		return this.host.adapter.modelCallUsage !== undefined;
	}
`);
t = t.replace('this.adapter.modelPolicy.refineWindowFromUsage', 'this.host.adapter.modelPolicy.refineWindowFromUsage');
t = t.replace('this.models.refineWindow', 'this.host.models.refineWindow');
t = t.replace('this.requestEmitter.fire(', 'this.host.measured(');
t = t.replace(/this\.turnEmitter\.fire\(/g, 'this.host.finished(');
t = t.replace(/this\.saved\b/g, 'this.host.saved');
t = t.replace(/this\.destroySession\(/g, 'this.host.destroySession(');
t = t.replace(/this\.isSignInRequired\(/g, 'this.host.isSignInRequired(');
t = t.replace(/this\.promptSignIn\(/g, 'this.host.promptSignIn(');
t = t.replace(/this\.needsCredentials\(/g, 'this.host.needsCredentials(');
t = t.replace(/this\.adapter\./g, 'this.host.adapter.');
t = t.replace('\tprivate startTurn(', '\tstart(');
t = t.replace('\tprivate async driveTurn(', '\tasync drive(');
t = t.replace('\tprivate async abortTurn(', '\tasync abort(');
t = t.replace(/this\.startTurn\(/g, 'this.start(');
t = t.replace(/this\.driveTurn\(/g, 'this.drive(');
t += `
/** Reports a thinking chunk when the running VS Code exposes thinking parts. */
function reportThinking(progress: vscode.Progress<vscode.LanguageModelResponsePart>, text: string): void {
	const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => unknown }).LanguageModelThinkingPart;
	if (ThinkingPart) {
		progress.report(new ThinkingPart(text) as vscode.LanguageModelResponsePart);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}
`;
fs.writeFileSync(file, t);
console.log('ok');
