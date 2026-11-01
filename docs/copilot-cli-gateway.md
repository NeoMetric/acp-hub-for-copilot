# Using the extension's models from Copilot CLI (LLM gateway)

Status: **parked**. Evaluated on 2026-10-30; nothing here is built. This records the options, findings and open questions so the work can be picked up later.

## Goal

Run `copilot` (GitHub Copilot CLI) in a terminal and use the models this extension exposes (Claude, Codex, Antigravity agents) instead of, or next to, GitHub-hosted models.

## Why it doesn't work today

- The extension registers one `vscode.lm` chat provider per agent (`src/extension.ts`). That API only exists inside a running VS Code extension host, so the standalone `copilot` process cannot see it.
- Each "model" is really an ACP agent subprocess wrapped by `src/core/provider.ts`.
- Copilot CLI only lists GitHub models plus whatever its BYOK configuration adds.

## How Copilot CLI accepts outside models

Per the GitHub docs (BYOK / "Adding LLM models to Copilot CLI"):

- Env vars: `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE` (`openai` default, `azure`, `anthropic`), `COPILOT_PROVIDER_API_KEY`, `COPILOT_MODEL`. Setting these **replaces** GitHub model routing for that session (community request for side-by-side use: github/community discussion 194778).
- `~/.copilot/providers.json` (or the path in `COPILOT_PROVIDERS_CONFIG`): models listed there appear in the CLI model picker **alongside** the GitHub models. Preferred.
- The target must support tool calling and streaming.

So any approach reduces to: serve an OpenAI- or Anthropic-compatible endpoint that fronts the ACP agents, then point the CLI at it.

## Options considered

| # | Option | Works with VS Code closed? | Effort | Notes |
|---|--------|----------------------------|--------|-------|
| A | Proxy hosted inside the extension (localhost HTTP, translates to `vscode.lm`) | No, needs one VS Code window open | A few days | Recommended first step. Cleanest, reuses the existing provider. |
| B | Headless daemon extracted from the extension core, shared by the extension and the CLI | Yes | 1-2 weeks, mostly refactor | One codebase, two front ends (VS Code adapter and HTTP server). |
| C | Standalone gateway that drives ACP agents directly | Yes | Similar to B, plus a fork to maintain | Best only if the extension is retired or made a thin client. If chosen, extract the existing core rather than rewriting it. |
| D | Expose the agents as an MCP server (`ask_claude`, ...) | No | Small | CLI keeps a GitHub model; the agents become tools, not selectable models. |
| E | Use Copilot's agent-host sessions inside VS Code | n/a | none | Extension models are already visible there; no terminal CLI. |

Practical middle path: build A now, but write the server against plain interfaces instead of calling `vscode.*` directly, so B stays possible.

### Notes on "single VS Code window open" (option A)

Works for any terminal and any folder because the extension host lives as long as any window. Caveats:

- Fixed port with fallback, and a persisted token, so `providers.json` doesn't go stale. Do not use a random port per launch.
- Several windows contend for the port: the second window should detect it and not start a proxy; the first window owns it, and the CLI loses it if that window closes.
- When all windows are closed the CLI still lists the models (static file) but requests fail with connection refused.
- Working directory: ACP sessions need a `cwd`; the CLI runs elsewhere, so take it from a request header or setting.
- Keep CLI conversations separate from chat tabs when reusing sessions.
- Bind to localhost only and require a bearer token; otherwise any local process can spend the agent subscriptions.

## Source-code audit (B/C feasibility)

- 21 of 58 files under `src/` import `vscode`; 20 of those are in `src/core`. Many are likely type-only or thin (settings, secrets, state, logging, prompts), but `src/core/provider.ts` implements the VS Code provider interface and `src/core/convert.ts` is built on the VS Code chat message types.
- Likely vscode-free already: the ACP/RPC layer, adapters, registry.
- Needed for a headless host: a neutral request/response format, non-VS Code versions of settings (config file), secrets (OS keychain), state (file), logging, and sign-in/install prompts (terminal flow).
- Suggested next step before committing: classify the 21 files as type-only / config-secrets / UI prompt / deep coupling.

## Tool calling (built-in tools disabled)

This already works in the extension and carries over:

1. Client sends a chat request with its tool definitions.
2. The gateway opens an ACP session and registers those tools with a loopback MCP server (one bearer token per session). `src/core/bridge.ts`.
3. The agent calls an MCP tool; the gateway does not run it. It writes the call into the response (`tool_calls` delta for OpenAI, `tool_use` for Anthropic) and ends the response with `finish_reason: tool_calls`. The agent's turn stays suspended. `src/core/provider/heldCalls.ts`.
4. The client runs the tool (keeping its own permission prompts) and sends a new request with the result.
5. The gateway matches the result by call id, completes the waiting MCP call, and streams the agent's continuation.

Built-in tools are already disabled for Claude (`tools: []`) and Antigravity (`useAgentBuiltInTools` setting). The bridge is already a plain `http` server.

Harder in a gateway than in the extension:

- Agent turns span several HTTP requests and must be kept alive and found again by tool-call id; abandoned turns need a timeout.
- A new conversation has no call id to match; use a history fingerprint (`fingerprint` / `diverged` in `convert.ts`).
- Client disconnect must cancel the agent turn; parallel calls and calls arriving between responses rely on the "held calls" logic.
- The client may change its tool set mid-conversation; the bridge already supports replacing a session's tool list.

## Prompt handling

Current behavior is tuned to VS Code Copilot Chat's prompts:

- Identity/persona sentences are stripped by regexes (`src/core/identityPatterns.ts`) because the agent has its own identity.
- An intro is appended to the agent's system prompt with required tool arguments and pointers to instruction files (`src/core/systemPrompt.ts`).
- Workspace folders, working directory, user/mode instructions and chat context are parsed from VS Code's prompt structure (`src/core/requestContext.ts`, `src/core/convert.ts`).
- The system guidance is hashed to decide whether a session can be reused.

With Copilot CLI as the client:

- Identity patterns won't match the CLI's wording, so the agent could carry two identities.
- Working directory and instructions won't be found in the CLI's format; a header or setting is needed for `cwd`.
- Customization-file discovery would duplicate what the CLI already puts in its prompt.
- If the CLI's system prompt contains volatile text (timestamps, git status), the guidance hash changes every turn and prompt caching / session reuse is lost; that text must be normalised or moved.

Proposed design: **client profiles** (`vscode-copilot`, `copilot-cli`, `generic`). Each defines identity patterns, how to read cwd and instructions, and what to append. `generic` passes the client's system prompt through untouched. Tune `copilot-cli` by capturing real CLI requests (the extension's request-dump setting helps).

Security note: tool outputs and file contents remain the usual injection vector; the client still executes tools and shows its own confirmations. The gateway adds requirements for localhost-only binding with token auth, and untrusted workspaces must keep contributing no customization files.

## Open questions

- Is terminal use with VS Code closed actually required? If not, A is enough.
- If B/C: keep the extension as a thin client of the gateway, or retire it?
- Verify VS Code Copilot Chat's custom OpenAI-compatible model setting (name and tool-call behavior) so the same endpoint could serve VS Code too.
- What do real Copilot CLI requests look like (system prompt, tool schemas, streaming format)? Capture before designing the `copilot-cli` profile.
- Session identity for new conversations without a stable chat id.

## Suggested order when resumed

1. Capture sample Copilot CLI requests against a stub endpoint.
2. Build option A behind a setting (off by default), localhost + token, fixed port, command to write the `providers.json` entry.
3. Run the vscode-import audit; decide on B/C.
