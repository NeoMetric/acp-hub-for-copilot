# ACP Hub for Copilot — Claude/Codex/Antigravity Agents via ACP Adapters

**Your AI plans. Your agents. GitHub Copilot Chat.**

Bring Claude Code, Codex, and Antigravity into VS Code's Copilot Chat. Sign in with your existing provider account, pick an available model, and get to work in the Copilot interface you already know. Uses the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) to connect agents to Copilot Chat.

> ACP Hub for Copilot is an independent, unofficial extension. It is not affiliated with, endorsed by, or sponsored by Microsoft, GitHub, Anthropic, OpenAI, or Google. Claude, Codex, ChatGPT, Gemini, and Antigravity are trademarks of their respective owners and are used here only to identify the agents and services the extension works with.

<img src="claude-agent-picker-image.png" alt="Claude agent picker" width="30%"> <img src="codex-agent-picker-image.png" alt="Codex agent picker" width="30%"> <img src="google-agent-picker-image.png" alt="Google agent picker" width="30%">

## Why Agent Hub?

Agent Hub connects agents using the **Agent Client Protocol (ACP)**, the open protocol also used by editors such as Zed and JetBrains IDEs. It runs the providers' agents through ACP adapters and makes their models available in Copilot Chat.

- **Use your existing plans.** Connect your Claude, ChatGPT, and Antigravity accounts and use available models through their respective agents. API key authentication is also available.
- **Stay in Copilot Chat.** Work with your chosen agent through VS Code's familiar chat interface and Copilot tools.
- **One place to manage agents.** Install, sign in, configure settings, and switch between agents from the ACP Hub sidebar.
- **See your usage.** Keep an eye on available plan limits and cache hit rates without leaving VS Code.

<img src="primary_sidebar_image.png" alt="Agent Hub primary sidebar" width="400">

## Get started

You'll need **VS Code 1.105 or later**, **GitHub Copilot Chat**, and access to at least one supported provider.

1. Open **Agent Hub** in the activity bar.
2. Select **Add agent**, then choose Claude, Codex, or Antigravity. Existing installations appear automatically.
3. Install the agent if needed, then sign in or add an API key from its card.
4. Open **Copilot Chat**, choose the agent's model from the model picker, and start chatting.


Available models, usage limits, and authentication options depend on your provider and plan. Removing an agent from the sidebar does not uninstall it. Saved API keys can be removed from the sidebar; browser account sign-out is managed by the agent's own account tools.

## The server

The extension is a thin client: the agents, their sessions and their settings run in a small local server, not in the extension host.

- **Attach or start.** On activation the window asks `127.0.0.1` (the port from `acpHub.server.port`, default 8791) for a health answer. A server that answers as ACP Hub is attached to and never stopped. When nothing answers, the bundled server (`dist/server.js`, shipped in the VSIX) is started as a child of that window and the window waits for it to answer.
- **One server per machine.** Every window of the machine uses the same port, so they share one server. A server a window started exits when that window closes (or its extension host dies); the next window starts its own, and a turn that was running in the old one is lost.
- **A server of another kind.** A program that answers on the port but is not ACP Hub, or is of a version this extension does not speak, is left untouched: the providers say the server is not compatible, and changing the port setting fixes it. A rejected token names the token file.
- **The token.** Both sides read `<root>/server.token` in the shared store (`~/.acp-hub`, or `ACP_HUB_HOME`); it is made once, with a fresh random value.

Two settings belong to the extension itself. Both are also in the settings UI, and both take effect after a window reload:

- `acpHub.server.port` — the port the server answers on, on `127.0.0.1` (default `8791`).
- `acpHub.server.autoStart` — start the bundled server when nothing answers on the port (default on). Turn it off to run the server yourself.

To run the server by hand, from a checkout, build first (`npm run compile`) and then run `npm run server`. It reads `ACP_HUB_PORT` (default 8791), `ACP_HUB_TOKEN` (otherwise the stored token is used, or made), `ACP_HUB_PROMPTS_DIR` (where it reads the prompt files) and `ACP_HUB_HOME` (the shared store). A server started by hand runs until you stop it; windows attach to it and leave it running.

## Settings and usage

Configure each agent from its card in the sidebar, or by editing `<root>/config.json` in the shared store. Those are the only homes of agent settings: the extension contributes only the two server settings above, and an `acpHub.agents.*` value left in `settings.json` from an older version is ignored. The sidebar displays available plan limits and both last-turn and cumulative cache hit rates. Usage reporting varies by agent.

Two options control how much each request sends to the model. Both are off by default and restart the agent when changed:

- **Replace the system prompt** (Claude, Codex and Antigravity). Replaces the agent's own built-in prompt with Copilot's guidance for the chat plus a one-line identity, instead of adding Copilot's guidance to the end of the agent's prompt. Antigravity generates its prompt and cannot keep it beside a custom agent, so the Google agent keeps a short Antigravity persona when the toggle is off and takes Copilot's identity when it is on; either way Copilot's guidance follows, and Antigravity's sections about skills, artifacts and messaging stay.
- **Use the agent's built-in tools** (Antigravity). Off by default: the extension runs its own Antigravity agent with an empty tool allowlist, which removes Antigravity's own file, shell and search tools so only Copilot's tools are used. On: Antigravity's own agent runs with all of its tools and its own prompt.
- **Tool search** (Claude). Loads each Copilot tool's description only when the model needs it, instead of sending every tool's full description with every request. This shrinks the first request a lot when many tools are available, and may add a lookup step before a tool is first used. Not every model supports it. Codex and Antigravity already load tools this way.


## Privacy and permissions

Agent Hub passes your chat requests to the selected local agent. Requests can include conversation history, workspace instructions, file contents, tool definitions and tool results supplied by Copilot Chat. The agent can send this information and credentials to its provider; the provider's terms and privacy policy apply ([Anthropic](https://www.anthropic.com/legal/privacy), [OpenAI](https://openai.com/policies/privacy-policy/), [Google](https://policies.google.com/privacy)). Review those policies and avoid sharing information you cannot send to the selected provider. Agent Hub also contacts services to install agents and retrieve available models or usage information. Third-party agents and adapters may make their own network requests or collect telemetry under their own policies.

API keys entered in Agent Hub are stored by the server in `<root>/secrets.json` in the shared store, readable by your account only (`0600`), and passed to the selected agent when needed; a key saved by an older version is copied there once, and the copy in VS Code's secret storage is left as it was. Agent account credentials and their retention are managed by the agents. The old "Dump requests" setting no longer has any effect: requests do not pass through the extension host, so no request files are written. Logs can still contain diagnostic details.

**Permission requests raised by an ACP adapter agent itself are automatically approved by Agent Hub** when an allow option is offered. This applies only to the agent's own built-in tools, for example when you enable Antigravity's built-in file, shell and search tools; those run without a confirmation prompt. Tools provided by Copilot Chat are not affected: they always go through Copilot's normal confirmation flow. Review the agent's own configuration and use only agents and workspaces you trust.

Agent Hub is disabled in VS Code Restricted Mode and requires a trusted workspace.

## Contributing

Run `npm ci`, then `npm run compile` and press **F5** to launch an Extension Development Host. Use `npm test` for unit tests and `npm run package` to create a VSIX.

Agent metadata lives in the [registry](registry/agents.json). After changing it, run `npm run generate` and `npm run generate:check`. Agents with custom behavior implement `AgentAdapter` in `src/adapters` and are registered in `src/core/agents.ts`. For details, see the [design](docs/superpowers/specs/2026-10-30-acp-hub-design.md) and [parity checklist](docs/parity-checklist.md).

To release, set the version in `package.json` and `package-lock.json`, rename the changelog's `Unreleased` section to that version, and commit. Work through the [parity checklist](docs/parity-checklist.md) with each provider signed in, then either run `npx vsce publish` from the repository root with a Marketplace PAT, or run the **Release** workflow in GitHub Actions, which needs a `VSCE_PAT` repository secret.
