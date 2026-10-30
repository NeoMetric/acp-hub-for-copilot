'use strict';

/**
 * A scriptable stand-in for the Codex app server, so the on-demand plan-limit
 * read can be tested without a ChatGPT sign-in and without the real binary.
 * The wire shapes mirror what the real server writes: no `jsonrpc` field,
 * notifications with `emittedAtMs` instead of an id, and `account/rateLimits/read`
 * with no parameters.
 */

const fs = require('node:fs');

const mode = process.env.FAKE_APP_SERVER_MODE ?? 'ok';
const pidFile = process.env.FAKE_APP_SERVER_PID_FILE;
const logFile = process.env.FAKE_APP_SERVER_LOG;

const note = line => {
	if (logFile) {
		fs.appendFileSync(logFile, `${line}\n`);
	}
};

if (pidFile) {
	fs.writeFileSync(pidFile, String(process.pid));
}
note(`argv ${process.argv.slice(2).join(' ')}`);
note(`electron-run-as-node ${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'}`);
if (process.env.CODEX_HOME) {
	note(`codex-home ${process.env.CODEX_HOME}`);
}

if (mode === 'exit') {
	note('exiting');
	process.exit(3);
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

/** The transport refuses every method but `initialize` until the handshake happened (probe note, question 8). */
let handshaken = false;

function handle(line) {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		note('unreadable request');
		return;
	}

	note(`request ${request.method}`);
	if (request.method === 'initialize') {
		note(`initialize-params ${JSON.stringify(request.params ?? null)}`);
		handshaken = true;
		send({ id: request.id, result: { userAgent: 'fake-app-server/0.0.0', codexHome: 'nowhere', platformFamily: 'windows', platformOs: 'windows' } });
		send({ method: 'remoteControl/status/changed', params: { status: 'disabled' }, emittedAtMs: Date.now() });
		return;
	}

	if (!handshaken) {
		note('refused-before-handshake');
		send({ id: request.id, error: { code: -32600, message: 'initialize required before any other request' } });
		return;
	}

	if (request.method !== 'account/rateLimits/read') {
		send({ id: request.id, error: { code: -32601, message: `no such method: ${String(request.method)}` } });
		return;
	}

	note(`params ${request.params === undefined ? 'omitted' : JSON.stringify(request.params)}`);
	if (mode === 'quiet') {
		note('quiet');
		return;
	}
	if (mode === 'garbage') {
		process.stdout.write('this line is not JSON\n{"id":2,"resu');
		note('garbage');
		return;
	}
	if (mode === 'auth-error') {
		send({ id: request.id, error: { code: -32600, message: 'chatgpt authentication required to read rate limits' } });
		return;
	}

	send({ id: request.id, result: JSON.parse(process.env.FAKE_RATE_LIMITS ?? '{}') });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
	buffer += chunk;
	for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			handle(line);
		}
	}
});
