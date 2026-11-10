/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A stand-in for the ACP Hub server in the link's tests: it answers `/health`
// the way the real one does, asks for a bearer token when ACP_HUB_TOKEN names
// one, answers the cheap `/api/state` the link checks its token with, and exits
// when its stdin closes if it was started with `--exit-with-parent`.
//   ACP_HUB_PORT            the port to listen on; 0 lets the OS pick one
//   ACP_HUB_TOKEN           the bearer token to require, when set
//   ACP_HUB_SLOW_MODELS_MS  how long `/v1/models` takes, standing in for a cold
//                           server that wakes every agent before it answers
//   ACP_HUB_VERSION         the version `/health` names, '0.0.0-stub' by default
// `POST /shutdown` closes it, as on the real server.

const http = require('node:http');

const NAME = 'acp-hub';
const API_VERSION = 1;
const TOKEN = process.env.ACP_HUB_TOKEN ? process.env.ACP_HUB_TOKEN.trim() : undefined;
const SLOW_MODELS_MS = Number(process.env.ACP_HUB_SLOW_MODELS_MS || 0);
const EXIT_WITH_PARENT = process.argv.indexOf('--exit-with-parent') !== -1;

const HEALTH = { status: 'ok', name: NAME, version: process.env.ACP_HUB_VERSION || '0.0.0-stub', apiVersion: API_VERSION, openSessions: 0, agents: [] };

function send(response, status, body) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

function quit() {
	server.closeAllConnections();
	process.exit(0);
}

const server = http.createServer((request, response) => {
	const path = (request.url || '/').split('?')[0];
	// The health probe is open, as it is on the real server, so a client can
	// learn who answers before it has a token.
	if (path === '/health' && request.method === 'GET') {
		send(response, 200, HEALTH);
		return;
	}
	if (TOKEN !== undefined && request.headers.authorization !== `Bearer ${TOKEN}`) {
		send(response, 401, { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } });
		return;
	}
	if (path === '/shutdown' && request.method === 'POST') {
		response.once('finish', quit);
		send(response, 202, { status: 'stopping' });
		return;
	}
	if (path === '/api/state' && request.method === 'GET') {
		// The cheap authenticated route the link verifies its token with.
		send(response, 200, { agents: [] });
		return;
	}
	if (path === '/v1/models' && request.method === 'GET') {
		const answer = () => send(response, 200, { object: 'list', data: [] });
		if (SLOW_MODELS_MS > 0) {
			// A cold server: the list costs a wake-up per agent before it can answer.
			setTimeout(answer, SLOW_MODELS_MS);
			return;
		}
		answer();
		return;
	}
	send(response, 404, { error: { message: 'not found' } });
});

server.listen(Number(process.env.ACP_HUB_PORT || 0), '127.0.0.1', () => {
	console.error(`${new Date().toISOString()} INFO stub-server listening on port ${server.address().port}`);
});

server.on('error', error => {
	// The real server exits the same way, naming the reason the link looks for.
	console.error(`${new Date().toISOString()} ERROR stub-server cannot start: ${error.message}`);
	process.exit(1);
});

if (EXIT_WITH_PARENT) {
	process.stdin.resume();
	process.stdin.on('end', quit);
	process.stdin.on('close', quit);
}
