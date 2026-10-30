# ACP Hub for Copilot

ACP Hub brings Claude, Codex, and Google ACP agents into GitHub Copilot Chat. Use the ACP Hub sidebar to install an agent, sign in, configure it, and view usage.

Each agent has its own vendor ID and settings under `acpHub.agents`, so the extension can be installed alongside the separate Claude, Codex, and Google ACP extensions. The sidebar can remove saved API keys; browser account sign-out must be managed through the agent's own account tools.

## Development

Requires Node.js and VS Code 1.105 or later. Run `npm ci`, then `npm run compile` and press F5 to launch an Extension Development Host. Run `npm test` for unit tests and `npm run package` to create a VSIX.

## Adding an agent

The local [registry](registry/agents.json) supplies vendor declarations and settings. Run `npm run generate` after changing it, and `npm run generate:check` to check the generated manifest. An agent with an existing CLI can supply an install specification, launch arguments, environment, and authentication methods in the registry. For an API key method, set `agentMethodId` when the agent advertises an ACP authentication method other than `api-key`. An npm agent also needs a pinned package manifest and lockfile under `adapters/<id>`.

Agents needing custom behavior use an implementation of `AgentAdapter` in `src/adapters`; register it in `src/core/agents.ts` and add its metadata to the registry. Keep agent-specific behavior in the adapter.

The [design](docs/superpowers/specs/2026-10-30-acp-hub-design.md) and [parity checklist](docs/parity-checklist.md) describe the intended behavior and manual verification.
