# ACP Hub — the extension as a thin client of the server

Date: 2026-11-09. Status: draft for approval. Builds on
`2026-11-09-two-host-core-design.md` (one engine, two hosts), which is done:
the engine, the HTTP host and the control page exist.

## Intent and why

Today the extension runs its own copy of the engine inside the VS Code
extension host (`src/extension.ts` → `src/core/provider.ts` → `ChatService`),
while a separate server process runs the same engine behind
`/v1/chat/completions`. The two paths can drift, and the owner wants to
validate the runtime behaviour of the server, the path every other client
(Copilot CLI, any OpenAI client) uses. So the extension stops running agents.
It keeps the VS Code surfaces (the model picker entries and the sidebar) and
talks to the server for everything. Agents run in one place, always as a
server process.

## Goals

1. All agent work (chat turns, tools, install, sign-in, usage, settings)
   happens in the server process. The extension host runs none of it.
2. Models still appear in the Copilot model picker as **three providers, one
   per agent** (Claude Agent, Codex Agent, Google Agent), as on `main`, with the
   same model names and effort variants.
3. **Lifecycle.** On activation the extension probes the server. If one
   answers, it attaches and never stops it. If none answers, the extension
   starts one and that server dies with VS Code, including when VS Code is
   killed.
4. The sidebar is the same page bundle as the server's browser page; no second
   UI. It reaches the server through a relay in the extension host.
5. The in-host engine path is deleted, not hidden behind a setting.

## Non-goals

- No new agent, no change to the engine's behaviour, no new on-disk schema.
- No remote server (a server on another machine); the server stays loopback.
- No Marketplace publishing changes.

## Anti-goals

- A second UI or a second copy of the control logic for the sidebar.
- Two code paths for the same turn (an in-host fallback "just in case").
- The server learning about VS Code. Anything VS Code-specific stays in the
  extension and reaches the server as a generic request header or field.
- Losing a feature the extension has today without saying so. Where the HTTP
  surface cannot carry a feature yet, the design names it (see Gaps).

## Constraints

- Windows is the tested platform; the child-process and shutdown handling must
  work there (no POSIX signals as the only mechanism).
- Remote windows (Remote-SSH, WSL, Codespaces) put the extension host next to
  the server and the webview elsewhere; only the extension host may talk to the
  server's `127.0.0.1`.
- `src/engine` stays free of `vscode`; the extension gets the same boundary
  rules `eslint` already enforces.
- `npm run typecheck`, `npm run lint`, `npm test` stay green at each step.
- The shared store layout does not change: external and bundled servers read
  and write the same files.

## Approaches considered

### Overall shape

There is one sensible shape, so no alternatives are listed for it: the
extension keeps a thin `LanguageModelChatProvider` per agent because VS Code
only lists models from a registered provider. Pointing Copilot's own
OpenAI-compatible setting at the server would need no extension code, but it
cannot start the server, cannot place the models under the agent providers,
and cannot carry the VS Code-only context, so it does not meet the goals.

### Sidebar transport (decided)

| | Approach | Verdict |
|---|---|---|
| **1** | Relay in the extension host: the webview keeps `postMessage`; the host forwards actions to `POST /api/action` and pushes `/api/events` back as state. | **Picked.** No page change, no CORS/CSP work, the token stays out of the webview, works in remote windows. |
| 2 | Webview calls the server directly over the HTTP transport. | Rejected: CORS/CSP opening, token in the webview, fails in remote windows. |
| 3 | Webview is an iframe of the server's `/`. | Rejected: same remote problem, token in the URL, no VS Code-only actions. |

### Providers (decided)

Three providers, one per agent, as on `main`. A single "ACP Hub" provider was
considered and rejected by the owner. Each provider lists the models of its own
agent: `GET /v1/models` ids are `<agentId>/<modelId>` and `owned_by` is the
agent id, so a provider filters on `owned_by`.

## Design

### 1. The server's lifecycle, owned by the extension

- **Where it lives:** the server bundle (`server-dist/server.js`) ships inside
  the VSIX (check `.vscodeignore`; it is excluded or missing today if so).
- **Address:** a fixed port (default 8791, overridable by a setting) and a
  bearer token persisted in the shared store, so every window and any external
  client agree. The token is generated once if absent.
- **Attach or start:** on activation the extension calls `GET /health`.
  - Answers: attach. The extension never signals or stops this server.
  - No answer: spawn the server as a child with `process.execPath` and
    `ELECTRON_RUN_AS_NODE=1`, with stdin as a pipe, and wait for `/health`.
  - Two windows racing: the port bind is the lock. The loser gets
    `EADDRINUSE` (the server already exits with an error), then re-probes and
    attaches.
- **Dying with VS Code:** the server, when started with a flag (for example
  `--exit-with-parent`), exits when its stdin closes. A closed pipe is how a
  crashed or force-killed extension host is noticed on Windows too. A server
  started by hand has no such flag and runs until stopped. `deactivate()` also
  sends a graceful stop.
- **Window 1 closes while window 2 is attached to its server:** window 2's next
  health check or request fails, and it runs the same attach-or-start step.
  "Takeover" means exactly this: window 2 starts a new server of its own, which
  then dies with window 2. It never becomes the parent of a server that is
  still running. Any turn in flight is lost. A reload of the extension host
  behaves the same way.
- **Validating a server before attaching (my call):** `GET /health` gains
  `name`, `version` and an integer `apiVersion`. The extension attaches only to
  a server that identifies as ACP Hub with an `apiVersion` it supports. A
  server that answers but is not ACP Hub, or is too old or too new, is never
  killed or restarted; the providers show a readable "server on port N is not
  compatible" message, and the user can change the port setting. A rejected
  token (401) shows its own message naming the token file.
- **Health watch:** a light periodic probe (and any failed request) moves the
  provider to "server unavailable" with a readable message and retries the
  attach-or-start step.

### 2. The thin chat provider (`src/hosts/vscode/`)

One class instance per agent, implementing `LanguageModelChatProvider`:

- `provideLanguageModelChatInformation`: `GET /v1/models`, keep entries with
  `owned_by === agentId`, map to `LanguageModelChatInformation`.
- `provideLanguageModelChatResponse`: translate VS Code messages and tools to
  OpenAI JSON, `POST /v1/chat/completions` with `stream: true`, translate the
  SSE deltas to `LanguageModelTextPart` and `LanguageModelToolCallPart`, abort
  the request on cancellation.
- `provideTokenCount`: estimate locally.
- VS Code-only context travels as headers the server already understands:
  `x-chat-id` (a stable chat id) and `x-acp-cwd` (the workspace folder). The
  regex recovery of identity and working directory from Copilot's rendered
  prompt (`src/core/requestContext.ts`, `src/hosts/vscode/identity.ts`) either
  stays in the extension to compute those headers, or moves to a server-side
  client profile. That choice is the builder's, with the constraint that the
  server contains nothing named after VS Code.

### 3. The sidebar relay

`SidebarHost` keeps its `ControlTransport` shape. Its `ControlPage` (which
today wraps an in-process `ControlService`) is replaced by an HTTP-backed
control surface in the extension host: `state()` from `GET /api/state`, changes
from the `/api/events` stream (reconnecting), actions to `POST /api/action`.
VS Code-only actions (open a URL, copy text) are handled in the extension host
as the sidebar does today. Sign-in URLs the agent shows already flow as state
from the server.

### 4. Settings (decided by the owner)

The server reads its settings from `<root>/config.json`
(`src/hosts/http/config.ts`), re-read on change, using the same `acpHub.*`
dotted keys VS Code uses. The sidebar's setting changes already go through the
control service's `writeConfig`, which on the server writes that file.

**Decision: the sidebar and `config.json` are the only settings home.** The
`acpHub.agents.*` settings the extension contributes in `package.json` are
removed, along with the `onDidChangeConfiguration` handling for them. The
extension keeps only the settings it needs itself (the server port, and
whether to start a bundled server). Values a user already has under
`acpHub.agents.*` in `settings.json` are not migrated automatically (my call);
the changelog says where settings live now. Sign-in secrets already live in the
shared store.

### 5. What is deleted

The in-host engine path: `src/core/provider.ts` and `src/core/provider/*`,
`convert.ts`, the adapter launch and sign-in wiring in `extension.ts`, the
in-host `McpBridge`, `UsageStore`, `ControlService` and agent processes. The
builder works out the exact list by following what only the removed path
imports; `src/core/*` files the server still uses (for example `agents.ts`,
`registry.ts`) stay or move into the engine.

## Gaps the current HTTP surface has (to close, not to hide)

The server was built for plain OpenAI clients, so it does not yet carry what
the picker and the chat need from VS Code:

1. **Model metadata.** `/v1/models` returns only `id` and `owned_by`. The
   picker needs display name, context window, effort/variant choices, and
   capability flags (tool calling, vision). Extend the response with optional
   fields rather than a second endpoint.
2. **Images** in user messages and tool results are not read by the server.
3. **Thinking/reasoning** output is not streamed.
4. **Usage and cache accounting** reach the chat response only as a final
   usage chunk; the sidebar needs its per-agent windows, which come from the
   control state.
5. **Per-request choices** the picker exposes (effort, and so on) need a
   defined place in the request body.
6. **Idle wake**: the extension currently wakes a stopped agent when the window
   regains focus; this becomes a server call (or is dropped).
7. **Request dump** and the other debug settings need a home on the server.

Gaps 1 to 5 are required for this change. Gaps 6 and 7 are my call: they are
not required for the first working build, and each ships as a named, known
loss in the parity checklist unless it turns out to be a few lines. Nothing
else may be dropped without the owner's agreement.

Tools and permission prompts need no new work: the server already returns the
client's tool calls as `tool_calls` and resumes the held turn when the result
comes back (`ToolCallParking`), so Copilot keeps running tools and showing its
own confirmations. The agent's own permission requests are handled in the
engine's `AgentClient` (`session/request_permission`), not in VS Code.

## Approval and testing

- The tested surface is the HTTP surface: contract tests for the extended
  `/v1/models` and the new request fields, a lifecycle test (attach, start,
  race, parent exit, takeover), and the existing engine tests unchanged.
- The manual parity checklist (`docs/parity-checklist.md`) is run against the
  new build; "Reload window: no orphan agent processes" becomes "no orphan
  server".

## Left to the builder

- Step order and the exact deletion list.
- Names of settings (port, token location) and the parent-exit flag.
- Where the identity/cwd recovery lives (extension or a server-side profile).
- How model metadata fields are named.
- Whether the health watch is a timer or only reactive.
