/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SERVER_COMMAND, SERVER_SCRIPT_POSIX } from './serverCommand';

function section(title: string, body: string): string {
	return `<details class="docs-section"><summary>${title}</summary><div class="docs-body">${body}</div></details>`;
}

const SERVER = section('Server', `
<p>ACP Hub is one local server on <code>127.0.0.1</code>. It runs the agents, serves this dashboard and exposes an OpenAI-compatible API (<code>/v1/models</code>, <code>/v1/chat/completions</code>). All VS Code windows and clients on this machine share it.</p>
<p>Requests need the bearer token in <code>server.token</code> in the ACP Hub store folder. The link at the top of this page includes it.</p>
<p>The VS Code sidebar shows this same page, with <strong>Start server</strong> when the server is down.</p>
<p>A window starts the server when it opens. After <strong>ACP Hub: Stop Server</strong>, a chat or the sidebar starts it again. A detached server closes itself after <code>acpHub.server.idleTimeoutMinutes</code> unused. With <code>acpHub.server.autoStart</code> off, a window only attaches to a running server and starts one on a chat message or <strong>Start server</strong>.</p>
<p>To run it without a window, in a terminal:</p>
<pre><code>${SERVER_COMMAND}</code></pre>
<p>That is PowerShell; on macOS or Linux use <code>${SERVER_SCRIPT_POSIX}</code>. It shares VS Code's token, settings and agents, prints this page's address, and runs until Ctrl+C (or <code>ACP_HUB_IDLE_MINUTES</code>). If a server already answers on the port, it exits.</p>
<p>Server settings:</p>
<ul>
<li><strong>Port</strong> (Server settings): applied after a restart. <code>ACP_HUB_PORT</code> overrides it on a hand-started server.</li>
<li><code>acpHub.server.idleTimeoutMinutes</code>: idle minutes before the server closes (default 30; <code>0</code> never).</li>
<li><code>acpHub.server.detached</code>: run outside VS Code so it survives closing a window (default on).</li>
<li><code>acpHub.server.autoStart</code>: start when a window loads (default on).</li>
<li><code>acpHub.proxy.url</code>: the proxy every agent is given, such as <code>http://127.0.0.1:7897</code>. Empty starts them without one, so a proxy set for the machine or the shell is the one in charge. <code>acpHub.proxy.noProxy</code> names the hosts they reach directly (default <code>127.0.0.1,localhost</code>, where the hub's own bridges answer).</li>
<li><strong>Settings for all agents</strong> (Agents tab): how earlier chats are restored, and their size limits.</li>
<li><strong>Keep history for</strong> (Usage tab): days of token usage kept.</li>
</ul>
<p>The idle limit, <strong>Detached</strong> and the proxy apply to the next server that starts; run <strong>ACP Hub: Stop Server</strong> to apply them.</p>`);

const VSCODE = section('VS Code Copilot client', `
<p>Each agent appears as a provider in the Copilot Chat model picker.</p>
<p>VS Code holds <code>acpHub.server.idleTimeoutMinutes</code>, <code>acpHub.server.detached</code>, <code>acpHub.server.autoStart</code> and the proxy (<code>acpHub.proxy.url</code>, <code>acpHub.proxy.noProxy</code>); everything else is set in this dashboard.</p>
<p>Run <strong>ACP Hub: Sync Models</strong> from the Command Palette to update Copilot with the agents' models and the names set in the Models tab. Reload the window after renaming a provider.</p>`);

const CLI = section('Copilot CLI', `
<ol>
<li>Run <strong>ACP Hub: Sync Models</strong> in VS Code. It writes the models, with this server's address and token, to <code>~/.copilot/providers.json</code> (or the file in <code>COPILOT_PROVIDERS_CONFIG</code>), keeping your own entries.</li>
<li>Restart the CLI and pick a model beside the GitHub ones.</li>
</ol>
<p>Sync again and restart the CLI after changing the port, renaming a model or signing in to another agent.</p>`);

/** The Docs view: what the server is, and how the two Copilot clients reach it, as collapsed sections. */
export function renderDocsView(): string {
	return `<div class="docs-view">${SERVER}${VSCODE}${CLI}</div>`;
}
