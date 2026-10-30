/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A tiny ACP agent for tests: newline-delimited JSON-RPC on stdio.
// MOCK_ACP_MODE picks how it behaves:
//   normal             initialize, session/new, session/prompt streams "hello" and ends the turn
//   auth-required      session/new fails with error code -32000
//   crash-mid-request  exits while a prompt is running
//   garbage            writes a line that is not JSON before every message
//   slow               a prompt only ends once session/cancel arrives
//   usage              like normal; also answers account/rateLimits/read with fixed numbers
// Prompt text with a special meaning:
//   env:<NAME>   replies with the value of that environment variable
//   count        replies with the number of session/new requests received
//   permission   asks the client for permission first, then replies with the outcome
//   forget       fails as if the session no longer existed
// MOCK_ACP_FAIL_FILE: while that file exists the process exits at start.

const fs = require('node:fs');
const readline = require('node:readline');

const mode = process.env.MOCK_ACP_MODE || 'normal';

if (process.env.MOCK_ACP_FAIL_FILE && fs.existsSync(process.env.MOCK_ACP_FAIL_FILE)) {
	process.exit(1);
}

let sessions = 0;
let newRequests = 0;
let permissionRequests = 0;
const awaitingPermission = new Map();
const knownSessions = new Set();
const slowPrompts = new Map();

function send(message) {
	if (mode === 'garbage') {
		process.stdout.write('this is not json\n');
	}
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
	send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message } });
}

function text(sessionId, value) {
	send({
		jsonrpc: '2.0',
		method: 'session/update',
		params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } },
	});
}

const configOptions = [
	{
		id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'mock-1',
		options: [{ value: 'mock-1', name: 'Mock 1' }, { value: 'mock-2', name: 'Mock 2' }],
	},
	{
		id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium',
		options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
	},
];

function handlePrompt(message) {
	const sessionId = message.params.sessionId;
	const prompt = message.params.prompt[0].text;

	if (!knownSessions.has(sessionId) || prompt === 'forget') {
		fail(message.id, -32602, `Session ${sessionId} does not exist`);
		return;
	}
	if (mode === 'crash-mid-request') {
		process.exit(2);
	}
	if (mode === 'slow') {
		text(sessionId, 'working');
		slowPrompts.set(sessionId, message.id);
		return;
	}
	if (prompt === 'permission') {
		const requestId = `perm-${++permissionRequests}`;
		awaitingPermission.set(requestId, { promptId: message.id, sessionId });
		send({
			jsonrpc: '2.0',
			id: requestId,
			method: 'session/request_permission',
			params: {
				sessionId,
				toolCall: { toolCallId: 'call-1', kind: 'edit', title: 'Write a.txt' },
				options: [
					{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
					{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
				],
			},
		});
		return;
	}
	if (prompt.startsWith('env:')) {
		text(sessionId, process.env[prompt.slice(4)] ?? 'unset');
	} else if (prompt === 'count') {
		text(sessionId, `new:${newRequests}`);
	} else {
		text(sessionId, 'hello');
	}
	reply(message.id, {
		stopReason: 'end_turn',
		_meta: { quota: { token_count: { inputTokens: 3, outputTokens: 2 } } },
	});
}

readline.createInterface({ input: process.stdin }).on('line', line => {
	const message = JSON.parse(line);

	if (message.method === 'initialize') {
		reply(message.id, {
			protocolVersion: 1,
			authMethods: [{ id: 'mock-login', name: 'Mock login' }],
			agentInfo: { name: 'mock-acp-agent', title: 'Mock agent', version: '0.0.0' },
		});
	} else if (message.method === 'session/new') {
		newRequests++;
		if (mode === 'auth-required') {
			fail(message.id, -32000, 'Authentication required');
			return;
		}
		const sessionId = `s${++sessions}`;
		knownSessions.add(sessionId);
		reply(message.id, { sessionId, configOptions });
	} else if (message.method === 'session/resume') {
		knownSessions.add(message.params.sessionId);
		reply(message.id, { configOptions });
	} else if (message.method === 'session/set_config_option') {
		reply(message.id, { configOptions });
	} else if (message.method === 'session/close') {
		knownSessions.delete(message.params.sessionId);
		reply(message.id, {});
	} else if (message.method === 'session/prompt') {
		handlePrompt(message);
	} else if (message.method === 'session/cancel') {
		const promptId = slowPrompts.get(message.params.sessionId);
		if (promptId !== undefined) {
			slowPrompts.delete(message.params.sessionId);
			reply(promptId, { stopReason: 'cancelled' });
		}
	} else if (message.method === 'account/rateLimits/read' && mode === 'usage') {
		reply(message.id, {
			primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000 },
			secondary: { usedPercent: 7, windowMinutes: 10080, resetsAt: 1_800_500_000 },
		});
	} else if (message.id !== undefined && awaitingPermission.has(message.id)) {
		const waiting = awaitingPermission.get(message.id);
		awaitingPermission.delete(message.id);
		text(waiting.sessionId, `permission:${JSON.stringify(message.result.outcome)}`);
		reply(waiting.promptId, { stopReason: 'end_turn' });
	} else if (message.id !== undefined && message.method) {
		fail(message.id, -32601, `Method not found: ${message.method}`);
	}
});
