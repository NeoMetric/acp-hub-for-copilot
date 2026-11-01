# Agent Hub for Copilot — Claude/Codex/Antigravity Agents via ACP Adapters

**Your AI plans. Your agents. GitHub Copilot Chat.**

Bring Claude Code, Codex, and Antigravity into VS Code's Copilot Chat. Sign in with your existing provider account, pick an available model, and get to work in the Copilot interface you already know. Uses the [Agent Client Protocol (ACP)] to connect agents to Copilot Chat. 

<img src="claude-agent-picker-image.png" alt="Claude agent picker" width="30%"> <img src="codex-agent-picker-image.png" alt="Codex agent picker" width="30%"> <img src="google-agent-picker-image.png" alt="Google agent picker" width="30%">

## Why Agent Hub?

- **Use your existing plans.** Connect your Claude, ChatGPT, and Antigravity accounts and use available models through their respective agents. API key authentication is also available.
- **Stay in Copilot Chat.** Work with your chosen agent through VS Code's familiar chat interface and Copilot tools.
- **One place to manage agents.** Install, sign in, configure settings, and switch between agents from the ACP Hub sidebar.
- **See your usage.** Keep an eye on available plan limits and cache hit rates without leaving VS Code.

Agent Hub connects agents using the **Agent Client Protocol (ACP)**, the open protocol also used by editors such as Zed and JetBrains IDEs. It runs the providers' agents through ACP adapters and makes their models available in Copilot Chat.

<img src="primary_sidebar_image.png" alt="Agent Hub primary sidebar" width="400">

## Get started

You'll need **VS Code 1.105 or later**, **GitHub Copilot Chat**, and access to at least one supported provider.

1. Open **Agent Hub** in the activity bar.
2. Select **Add agent**, then choose Claude, Codex, or Antigravity. Existing installations appear automatically.
3. Install the agent if needed, then sign in or add an API key from its card.
4. Open **Copilot Chat**, choose the agent's model from the model picker, and start chatting.


Available models, usage limits, and authentication options depend on your provider and plan. Removing an agent from the sidebar does not uninstall it. Saved API keys can be removed from the sidebar; browser account sign-out is managed by the agent's own account tools.

## Settings and usage

Configure each agent from its card or search for `AgentHub` in VS Code Settings. The sidebar displays available plan limits and both last-turn and cumulative cache hit rates. Usage reporting varies by agent.

Want to use the agents with Copilot CLI? See the [gateway guide](docs/copilot-cli-gateway.md).

## Contributing

Run `npm ci`, then `npm run compile` and press **F5** to launch an Extension Development Host. Use `npm test` for unit tests and `npm run package` to create a VSIX.

Agent metadata lives in the [registry](registry/agents.json). After changing it, run `npm run generate` and `npm run generate:check`. Agents with custom behavior implement `AgentAdapter` in `src/adapters` and are registered in `src/core/agents.ts`. For details, see the [design](docs/superpowers/specs/2026-10-30-acp-hub-design.md) and [parity checklist](docs/parity-checklist.md).
