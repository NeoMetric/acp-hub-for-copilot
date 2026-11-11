/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SERVER_COMMAND, SERVER_SCRIPT_POSIX } from './serverCommand';

function section(title: string, body: string): string {
	return `<details class="docs-section"><summary>${title}</summary><div class="docs-body">${body}</div></details>`;
}

const SERVER = section('Server', `
<p>ACP Hub runs as one small local server on <code>127.0.0.1</code>. It serves this dashboard and an OpenAI-compatible API (<code>/v1/models</code>, <code>/v1/chat/completions</code>), and it runs the agents. Every VS Code window and every client on this machine shares it.</p>
<p>Every request needs the bearer token kept in <code>server.token</code> in the ACP Hub store folder. The link at the top of this page carries it, so a browser tab stays signed in.</p>
<p>The VS Code sidebar is this same page. When the server is not running, the sidebar says so and offers <strong>Start server</strong>.</p>
<p>A window starts the server when it opens, and starts it again when a chat or the sidebar asks for one after <strong>ACP Hub: Stop Server</strong>; a detached server then closes itself once no window has used it for <code>acpHub.server.idleTimeoutMinutes</code>. With <code>acpHub.server.autoStart</code> off, a window only attaches to a server that already answers, and starts one only when you ask for it with a chat message or the sidebar's <strong>Start server</strong>.</p>
<p>To run the server yourself, with no window open, in a terminal:</p>
<pre><code>${SERVER_COMMAND}</code></pre>
<p>That is PowerShell on Windows; on macOS or Linux the file is <code>${SERVER_SCRIPT_POSIX}</code>. It reads the same store, so its token, settings and agents are the ones VS Code uses. It prints this page's address with the token, and it runs until you stop it with Ctrl+C unless you set <code>ACP_HUB_IDLE_MINUTES</code>. If a server already answers on the port, this copy exits: stop the running one first.</p>
<p>Server-level settings:</p>
<ul>
<li><strong>Port</strong>: in Server settings. A new port is used after a restart. <code>ACP_HUB_PORT</code> overrides it on a server started by hand.</li>
<li><code>acpHub.server.idleTimeoutMinutes</code>: minutes the server may go unused before it closes itself (default 30; <code>0</code> keeps it running).</li>
<li><code>acpHub.server.detached</code>: run the server outside VS Code so it survives closing a window (default on).</li>
<li><code>acpHub.server.autoStart</code>: start the server when a window loads (default on); off starts one only when a chat or the <strong>Start server</strong> button asks for it.</li>
<li><strong>Settings for all agents</strong> (Agents tab): how an earlier chat is restored, and its size limits.</li>
<li><strong>Keep history for</strong> (Usage tab): how many days of token usage the server keeps.</li>
</ul>
<p>These settings are read when a window loads; the idle limit and <strong>Detached</strong> take effect with the next server that starts, so run <strong>ACP Hub: Stop Server</strong> to apply them.</p>`);

const VSCODE = section('VS Code Copilot client', `
<p>The models of your agents appear in the model picker of Copilot Chat, one provider per agent.</p>
<p>The settings available in VS Code are <code>acpHub.server.idleTimeoutMinutes</code>, <code>acpHub.server.detached</code> and <code>acpHub.server.autoStart</code>; everything else is set here in the dashboard.</p>
<p>Run <strong>ACP Hub: Sync Models</strong> from the Command Palette to bring the agents' current models, and the provider and model names you chose in the Models tab, into Copilot. Reload the window afterwards if you renamed a provider.</p>`);

const CLI = section('Copilot CLI', `
<p>To use your agents from the GitHub Copilot CLI:</p>
<ol>
<li>Run <strong>ACP Hub: Sync Models</strong> from the Command Palette in VS Code. It writes the models, with this server's address and token, to <code>~/.copilot/providers.json</code> (or the file named by <code>COPILOT_PROVIDERS_CONFIG</code>). Entries you added yourself are kept. The same command updates the VS Code model picker.</li>
<li>Restart the CLI, then pick one of the models next to the GitHub ones.</li>
</ol>
<p>Run it again, and restart the CLI, after you change the port, rename a model or sign in to another agent.</p>`);

/** The Docs view: what the server is, and how the two Copilot clients reach it, as collapsed sections. */
export function renderDocsView(): string {
	return `<div class="docs-view">${SERVER}${VSCODE}${CLI}</div>`;
}
