# ACP Hub — your AI plans as a local model server

**Your AI plans. Your agents. Any client.**

ACP Hub runs the agents of your existing Claude, ChatGPT/Codex and Antigravity accounts behind one small local server and serves their models over an OpenAI-compatible API. Point GitHub Copilot CLI, the Copilot Chat of VS Code, or any other OpenAI-compatible client at it, pick a model, and work with the agent you already pay for. It uses the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) to talk to the agents.

> ACP Hub is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Microsoft, GitHub, Anthropic, OpenAI, or Google. Claude, Codex, ChatGPT, Gemini, and Antigravity are trademarks of their respective owners and are used here only to identify the agents and services the project works with.

<img src="claude-agent-picker-image.png" alt="Claude agent picker" width="30%"> <img src="codex-agent-picker-image.png" alt="Codex agent picker" width="30%"> <img src="google-agent-picker-image.png" alt="Google agent picker" width="30%">

## What it is

- **A local server.** It runs the agents, keeps their sessions, settings, sign-ins and usage, and answers on `127.0.0.1` only. Nothing is hosted for you; the agents run on your machine and talk to their own providers.
- **An OpenAI-compatible API.** `GET /v1/models` lists one model per agent and model (`<agentId>/<modelId>`, for example `claude/sonnet`), and `POST /v1/chat/completions` streams the answer, including tool calls: the client runs its own tools and sends the results back, so its own permission prompts still apply.
- **A control page.** A browser page, served by the same server, to install agents, sign in or add an API key, change their settings, watch plan limits and cache hit rates, and rename the models the pickers show.
- **Clients.** GitHub Copilot CLI, any OpenAI-compatible client, and an optional VS Code extension that puts the models in Copilot Chat's model picker and shows the control page in a sidebar. The extension is a thin client of the server; it holds no agents of its own.

Available models, usage limits and sign-in options depend on your provider and plan.

## Get started

You need **Node.js**, a checkout of this repository, and access to at least one supported provider.

1. Install and build: `npm ci`, then `npm run compile`.
2. Start the server: `npm run server`. It prints a link of the form `http://127.0.0.1:<port>/?token=<token>`.
3. Open that link once in a browser. It sets an `HttpOnly`, `SameSite=Strict` cookie, so the control page works from then on without the token.
4. On the control page, add Claude, Codex or Antigravity, install the agent if needed, and sign in or add an API key from its card. Existing installations appear automatically.
5. Point a client at the server (below).

The server keeps running until you stop it. Removing an agent from the page does not uninstall it. Saved API keys can be removed from the page; browser account sign-out is managed by the agent's own account tools.

## Using it from a client

### GitHub Copilot CLI

Open the **Models** view of the control page and press **Sync**. It fetches the agents' current models and writes them, with the server's address and token, to the CLI's `providers.json` (`~/.copilot/providers.json`, or `COPILOT_PROVIDERS_CONFIG`), so they appear in the CLI's model picker next to the GitHub models. Restart the CLI afterwards. Entries in that file that the server did not write are kept.

### Any OpenAI-compatible client

- **Base URL:** `http://127.0.0.1:8791/v1` (change the port with `ACP_HUB_PORT`).
- **Authentication:** send the server's token as a bearer token, `Authorization: Bearer <token>`. The token is in `server.token` in the shared store (`~/.acp-hub`, or `ACP_HUB_HOME`), or is the value of `ACP_HUB_TOKEN` when you set it.
- **Model:** the `id` that `GET /v1/models` returns, in the form `<agentId>/<modelId>`.
- **Thinking effort:** `reasoning_effort` in the request, with one of the levels the model offers (see **Settings** below for the level used when a request names none).
- **Chats and folders:** a client that sends an `x-chat-id` header keeps its conversation in one agent session, and `x-acp-cwd` names the folder the agent works in. A client that sends neither gets a chat named from the folder and the opening words of the conversation.

### VS Code

The optional extension (`acp-hub-for-copilot`, from a VSIX or the Marketplace) needs **VS Code 1.105 or later** and **GitHub Copilot Chat**. It adds the agents' models to the Copilot Chat model picker and an **Agent Hub** view in the activity bar with the same cards as the control page.

- **Attach or start.** On activation the window asks `127.0.0.1` (the port from `acpHub.server.port`, default 8791) for a health answer. A server that answers as ACP Hub is attached to and never stopped. When nothing answers, the extension starts the bundled server (`dist/server.js`, shipped in the VSIX) on its own, outside VS Code's process tree, and waits for it to answer.
- **One server per machine.** Every window uses the same port, so they share one server. A server the extension starts keeps running when the window that started it closes or reloads, so an agent stays warm; it runs on its own Node.js (the one on your PATH, otherwise Node.js 22 downloaded once into `<root>/node`; VS Code's own executable only when neither works), so closing or killing VS Code does not touch it. It logs to `server.log` in the store root, and every window shows those lines in its ACP Hub output channel; it closes itself, agents included, once no window has used it for `acpHub.server.idleTimeoutMinutes` (default 30). Run **ACP Hub: Stop Server** to close it at once; the next chat starts it again. After an extension update the first window replaces a server left running by an older version. With `acpHub.server.detached` off the server is a child of the window that started it and exits with it, as before. A server you started yourself keeps running and windows only attach to it.
- **A server of another kind.** A program on the port that is not ACP Hub, or is of a version the extension does not speak, is left untouched and the model picker says the server is not compatible. Changing the port setting fixes it. A rejected token names the token file.
- **Settings.** The extension keeps five: `acpHub.server.idleTimeoutMinutes` (minutes a server no window uses stays up; default `30`, `0` never closes it), `acpHub.server.detached` (run the server outside VS Code; default on), `acpHub.server.warmAgents` (when a window connects, start every enabled agent in its first folder so the first chat does not wait; default on, and each folder keeps its own agent processes, which the idle timeout stops), `acpHub.server.port` (default `8791`) and `acpHub.server.autoStart` (start the bundled server when nothing answers; default on, turn it off to run the server yourself). A change applies after a window reload, and the idle limit and `detached` apply to the next server that starts, so run **ACP Hub: Stop Server** to restart it with new values. Agent settings live on the agent cards and in `<root>/config.json`; an `acpHub.agents.*` value left in `settings.json` by an older version is ignored.
- **Model names.** After you rename a provider in the Models view, reload the VS Code window; the provider names are also written to the extension's `package.json`, which an extension update or `npm run generate` resets (press **Sync** again then).
- **Restricted Mode.** The extension is disabled in VS Code Restricted Mode, because it runs agent processes and needs a trusted workspace.

<img src="primary_sidebar_image.png" alt="The ACP Hub sidebar in VS Code" width="400">

## Running the server

| Variable | Meaning | Default |
| --- | --- | --- |
| `ACP_HUB_PORT` | The port the server answers on, on `127.0.0.1` | `8791` |
| `ACP_HUB_TOKEN` | The bearer token clients send; otherwise the stored token is used, or made | `<root>/server.token` |
| `ACP_HUB_HOME` | The shared store: token, `config.json`, secrets, state and installed agents | `~/.acp-hub` |
| `ACP_HUB_PROMPTS_DIR` | Where the server reads its prompt files | built in |

- **Shared store.** The server, the extension and the control page all read the same folder, so an agent installed or signed in through one is there for the others.
- **The token.** It is made once with a fresh random value and is required on every API request. The server binds to `127.0.0.1` only, so other machines cannot reach it, but any local process that can read your token file can use your subscriptions; protect the folder as you would any credential.
- **Models view.** The control page's **Models** view sets the provider name of each agent and the name of each of its models. Press the pencil beside an agent's name to edit its provider name and all its model names together, then Save (an empty field keeps the agent's own name).

## Settings and usage

Configure each agent from its card on the control page, or by editing `<root>/config.json`. The page shows available plan limits and both last-turn and cumulative cache hit rates. Usage reporting varies by agent.

Options that control how much each request sends to the model, and how hard the model thinks:

- **Replace the system prompt** (Claude, Codex and Antigravity). Off by default; restarts the agent when changed. Replaces the agent's own built-in prompt with the client's guidance for the chat plus a one-line identity, instead of adding the guidance to the end of the agent's prompt. Antigravity generates its prompt and cannot keep it beside a custom agent, so the Google agent keeps a short Antigravity persona when the toggle is off and takes the client's identity when it is on; either way the guidance follows, and Antigravity's sections about skills, artifacts and messaging stay.
- **Use the agent's built-in tools** (Antigravity). Off by default; restarts the agent when changed. Off: the server runs its own Antigravity agent with an empty tool allowlist, which removes Antigravity's own file, shell and search tools so only the client's tools are used. On: Antigravity's own agent runs with all of its tools and its own prompt.
- **Tool search** (Claude). Loads each of the client's tool descriptions only when the model needs it, instead of sending every description with every request. This shrinks the first request a lot when many tools are available, and may add a lookup step before a tool is first used. Not every model supports it. Codex and Antigravity already load tools this way.
- **Default thinking effort** (each agent has its own). The effort used for a request that names none, such as a subagent started by a client's task tool. For Claude it also covers a chat left on the picker's Default. Claude starts at High, because the agent's own choice can be the most expensive level; Codex and Antigravity start at Default, which leaves the choice to the agent. An effort a request names is always kept.

## Privacy and permissions

ACP Hub passes the requests it receives to the selected local agent. Requests can include conversation history, workspace instructions, file contents, tool definitions and tool results supplied by the client. The agent can send this information and credentials to its provider; the provider's terms and privacy policy apply ([Anthropic](https://www.anthropic.com/legal/privacy), [OpenAI](https://openai.com/policies/privacy-policy/), [Google](https://policies.google.com/privacy)). Review those policies and avoid sharing information you cannot send to the selected provider. ACP Hub also contacts services to install agents and retrieve available models or usage information. Third-party agents and adapters may make their own network requests or collect telemetry under their own policies.

API keys entered in ACP Hub are stored by the server in `<root>/secrets.json` in the shared store, readable by your account only (`0600`), and passed to the selected agent when needed; a key saved by an older version of the VS Code extension is copied there once, and the copy in VS Code's secret storage is left as it was. Agent account credentials and their retention are managed by the agents. Logs can contain diagnostic details.

**Permission requests raised by an ACP adapter agent itself are automatically approved by ACP Hub** when an allow option is offered. This applies only to the agent's own built-in tools, for example when you enable Antigravity's built-in file, shell and search tools; those run without a confirmation prompt. Tools provided by the client are not affected: the server hands each call to the client and the client's own confirmation flow decides. Review the agent's own configuration and use only agents and workspaces you trust.

## Contributing

Run `npm ci`, then `npm run compile`. Use `npm run server` to run the server, `npm test` for unit tests, and `npm run lint` and `npm run typecheck` before sending a change. To work on the VS Code client, press **F5** to launch an Extension Development Host, and use `npm run package` to create a VSIX.

Agent metadata lives in the [registry](registry/agents.json). After changing it, run `npm run generate` and `npm run generate:check`. Agents with custom behavior implement `AgentAdapter` in `src/adapters` and are registered in `src/core/agents.ts`. For details, see the [design](docs/superpowers/specs/2026-10-30-acp-hub-design.md), the [server-only runtime design](docs/superpowers/specs/2026-11-09-server-only-runtime-design.md) and the [parity checklist](docs/parity-checklist.md).

To release, set the version in `package.json` and `package-lock.json`, rename the changelog's `Unreleased` section to that version, and commit. Work through the [parity checklist](docs/parity-checklist.md) with each provider signed in, then either run `npx vsce publish` from the repository root with a Marketplace PAT, or run the **Release** workflow in GitHub Actions, which needs a `VSCE_PAT` repository secret.