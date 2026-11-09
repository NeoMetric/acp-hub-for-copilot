# ACP Hub — two hosts over one engine

Date: 2026-11-09. Status: draft for approval. Supersedes the layering parts of
`2026-10-30-acp-hub-design.md`; its goals and anti-goals still hold.

## Intent and why

The extension works, but the code that would be shared with a standalone server
is not shared: 20 of 44 files under `src/core` import `vscode`, about 65% of
core's lines. The chat pipeline is written against VS Code's own chat model
(`vscode.LanguageModelChatRequestMessage`, `LanguageModelChatTool`,
`vscode.Progress<LanguageModelResponsePart>`), and chat identity, working
directory and system guidance are recovered by regex from Copilot's rendered
prompt (`src/core/requestContext.ts:21-33`,
`src/core/provider/keys.ts:135-141`,
`src/core/identityPatterns.ts:18-37`). The adapter interface exists, but core
combines the adapters' quirk flags into policy of its own: `AcpProvider.fork()`
(`src/core/provider.ts:654-720`) decides whether a session id may be kept,
whether the agent must restart, and whether the saved prompt is reused.

So there are two problems, not one:

1. **No host port.** The engine cannot run without VS Code because VS Code is
   its data model and its source of chat identity.
2. **Adapter behaviour leaks into core**, as a decision table over flags rather
   than as an implementation the adapter owns.

Both must be fixed before a second host is added, or the second host inherits
both.

## Goals

1. The extension keeps shipping, unchanged in behaviour, from the same repo.
2. One engine, no `vscode`, usable by two hosts.
3. A second entry point that serves an OpenAI-compatible
   `POST /v1/chat/completions` (streaming and non-streaming) and `GET /v1/models`.
4. An adapter's behaviour lives in the adapter. Core calls it; core never
   branches on which adapter it holds, neither by name nor by flag combination.
5. The scalability defects found in the diagnosis are fixed in the engine, so
   both hosts get them.
6. **One store, two gateways.** Both hosts read and write the same files, with
   the same schema, in one location. Nothing is duplicated per host.
7. **A web control page at parity with the sidebar.** Everything the sidebar
   shows and controls is available in a browser, served by the server; the two
   are one UI codebase, so a change to either is a change to both.

## Non-goals

- No redesign of the sidebar's information or flows: the web page is the same
  UI over a different transport, not a second design.
- No new agent added in this work.
- No Marketplace publishing changes.
- No shared multi-tenant authentication model for the server beyond a bearer
  token guard; the server is a single-user developer tool by default.

## Anti-goals

- A second copy of the core for the server (that recreates the three-fork
  problem this repo was built to end).
- The server feeding a fake VS Code-shaped request into today's core.
- Core containing `if (adapter.forkChats)`-style policy, or any other
  combination of adapter flags.
- Behaviour changes to the extension that are not covered by an existing test.

## Constraints

- `src/engine` must contain no `import ... from 'vscode'`, at all.
- Every step must keep `npm run typecheck`, `npm run lint`, `npm test` green,
  and the extension usable.
- The existing ACP sessions, saved sessions, forks, checkpoints and prompt-cache
  behaviour must survive the move: they are the product.
- Windows is the tested platform; nothing may rely on POSIX-only process
  handling.
- The extension's storage layout may change only with a migration path for
  saved sessions.

## Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | **Ports-first, in place.** Neutral model + host port inside the repo; extension keeps shipping; server added as a second entry; package split later if wanted. | Incremental and always green; slowest to a first HTTP request. | **Picked.** |
| B | Package-first: move core into `packages/core` now, both hosts consume it. | Cleaner boundary immediately, but a big-bang move before the seam exists. | Rejected for now; becomes a mechanical move after A. |
| C | Second entry with no neutral model: the server synthesises a VS Code-shaped request. | Fastest demo; permanently cements the fake-VS-Code coupling. | Rejected. |

## Target architecture

```
src/engine/            no vscode, no adapters, no hosts
  model/               neutral chat model and stream events
  ports/               HostPort, AgentPort, StateStore, SecretStore, ConfigReader
  acp/                 rpc, AgentClient, supervision, sessions, continuation
  chat/                ChatService: the use case the hosts call
  control/             ControlService: install, sign-in, settings, usage, agents
  store/               the shared on-disk store both gateways use
  install/             installers, npm, download
  usage/, cache/       usage sources and cache accounting

src/ui/                the sidebar page: one bundle, both transports
src/hosts/vscode/      the only place that knows about VS Code and Copilot
src/hosts/http/        the only place that knows about HTTP and OpenAI JSON
src/adapters/          claude, codex, google, generic — each self-contained
src/composition/       wired adapters + engine for each host (not in engine)
src/main/extension.ts  entry point 1
src/main/server.ts     entry point 2
```

Dependency rules, enforced by `eslint` `no-restricted-imports` per directory and
a test in `test/unit/boundaries.test.ts`:

- `src/engine/**` may not import `vscode`, `src/hosts/**`, `src/adapters/**`.
- `src/adapters/**` may import `src/engine/ports`, `src/engine/model`,
  `src/engine/acp/protocol` (types only: `AcpAuthMethod`, `AcpTokenUsage`,
  `ForkPoint`, `AgentSession`) and pure utilities. No ACP client internals, no
  session store internals, no process helpers: today `googleFork.ts:7` reaches
  into `core/sessionStore` and `googleHub.ts:4` into `core/processes`, and both
  of those become port methods. `RpcError` (`googleQuota.ts:1`) moves into the
  protocol module.
- `src/hosts/**` may import `src/engine/**` and `src/composition/**`.
- `src/ui/**` is the shared page: browser-targeted, no `vscode`, no `node:*`,
  no engine imports. It talks to a transport interface only.
- `src/core/**` is deleted when the move completes; no new code goes there.

### The neutral model

The engine's currency becomes its own types, not VS Code's:

- `Part`: text, image, tool-call, tool-result.
- `ChatMessage`: role (`system` | `user` | `assistant` | `tool`), parts, name.
- `ToolDef`: name, description, JSON schema.
- `ChatRequest`: `chatId`, `cwd`, messages, tools, model, effort,
  `systemGuidance`, host metadata.
- `StreamEvent`: `text`, `thought`, `tool-call`, `usage`, `done`, `error`.

`src/core/convert.ts` is split: the VS Code → neutral half moves to
`src/hosts/vscode/convert.ts`, the neutral → ACP half stays in
`src/engine/chat/prompt.ts`. `fingerprint`/`characterCountOf` become model
helpers.

### The host port

`HostPort` is the only thing an engine use case may ask a host for:

```ts
interface HostPort {
  log: Log;
  state: StateStore;            // replaces vscode.Memento
  secrets: SecretStore;
  settings: ConfigReader;       // already exists: src/core/settings.ts:6
  storageRoot: string;          // install root and per-agent state
  resolveLaunch(adapter, settings): Promise<LaunchContext | undefined>;
  chatIdentity(request): { id: string; cwd: string; workspaceFolders: readonly string[] };
  guidanceOf(request): string | undefined;
  executeTool(call, signal): Promise<ToolResult>;   // see below
  ui: { requestSignIn(agentId), notify(message, actions?), openExternal(url) };
  publishModels?(vendor): Promise<void>;            // VS Code workbench only
  dumpRequest?(dump): void;                          // debug
}
```

`chatIdentity` is where the VS Code host keeps its prompt scraping. The HTTP
host prefers explicit `x-chat-id` and `x-acp-cwd` headers, and otherwise falls
back to the same content fingerprint the VS Code path already uses when
`_conversationId` is absent: the workspace plus the opening messages
(`src/core/provider/keys.ts:141`). That keeps stock OpenAI clients, which send
neither header, both usable and resumable: a re-post repeats the same opening,
so it lands on the same session. Nothing outside `src/hosts/vscode` references
`<workspace_info>`, `<environment_context>`, `_conversationId`, or Copilot's
identity sentences.

### The agent port: facts and behaviour

The current interface mixes two kinds of thing. They are separated.

**Facts** — data the engine reads, because the agent reports or requires it:

`refreshesTools`, `declaresBridgeOnModelLookup`, `clientCapabilities`,
`clientIdentity`, `defaultSessionMode`, `sessionParams()`, `mergeConfig()`,
`authenticate()`, `mapError()`, `lastModelCall()`, `modelCallUsage()`,
`reportsCache`, `maxToolResultChars`.

**Behaviour** — functions the adapter implements, which the engine calls
without knowing why:

```ts
interface SessionPolicy {
  planContinuation(input: ContinuationInput): ContinuationPlan;
  afterRewind?(ctx): Promise<RewindOutcome>;   // restart, if this agent needs it
  promptForOpen(input): string | undefined;    // saved prompt vs rebuilt one
  toolsChanged?(ctx): ToolsChangeAction;       // reopen session vs list_changed
  toolWaitMs(settings): number;                // always finite
}
```

`ContinuationPlan` is one of `reuse | fork-native | fork-external | rebuild`,
computed **in the adapter**, from the adapter's own knowledge and the live
session inventory the engine passes in. `AcpProvider.fork()` collapses to: ask
the policy, then run the plan. A `NativeAcpPolicy` default covers adapters that
need nothing special.

The four flags that currently drive that method — `forkChats`,
`restartAfterFork`, `keepsSessionPrompt`, `rebuildExpiredSessions` — are
deleted. `rebuildExpiredSessions` and `systemPromptNote` are already unread
(`src/core/adapter.ts:217,270`).

A conformance suite runs every bundled adapter against the same scenarios
(session opens, tools change, expiry, fork, rewind), so an adapter that returns
a plan the engine cannot execute fails a test rather than at runtime.

### The use case

`ChatService` owns what `AcpProvider` owns today, minus VS Code:

- one instance per agent;
- the agent process and its supervision;
- chat sessions, reuse, forks, checkpoints, idle release;
- tool-call continuation (see below);
- usage and cache accounting.

`AcpProvider` becomes a ~150-line VS Code adapter: `ChatRequest` from
`vscode.LanguageModelChatRequestMessage`, `StreamEvent` to
`vscode.Progress`, `LanguageModelError` mapping, `publishModels`.

### Tool calls across two hosts

The existing model already fits OpenAI function calling: the turn outlives a
single response, and a tool result arrives on the next request
(`src/core/provider/turns.ts:63-152`, `heldCalls.ts`). So the engine keeps one
mechanism:

1. The agent calls a tool over the loopback MCP bridge.
2. The engine emits a `tool-call` stream event and holds the call.
3. The host delivers it and resolves the call with the result:
   - VS Code: the response ends, Copilot runs the tool, the next provider
     request carries the result.
   - HTTP: the response ends with OpenAI `tool_calls`; the client re-posts with
     `role: "tool"` messages; the engine matches them by `call_id`.
4. The turn resumes.

The bridge stays loopback and per-session. The **client executes tools**, not
the server: the server never runs a shell or edits a file on a caller's behalf
(see "Calls I made" below).

### Scalability work, in the engine

1. **Processes keyed by agent + workspace.** `AgentClient` today spawns with the
   window's first folder as cwd (`src/core/agentClient.ts:720`) and there is one
   per provider (`extension.ts:44`). Becomes a registry keyed by
   `agentId + workspaceRoot`, LRU-bounded, each process owning its sessions.
   `workspaceRoot` is the first folder the chat itself belongs to (the value
   `workspaceFoldersOf` already returns, normalised the way
   `normalizeFolder` does), falling back to the chat's `cwd`; it is not the
   chat's `cwd` when the latter is a subfolder, so one repo does not become
   several processes. Sessions keep carrying their own `cwd`.
2. **Quotas per owner, not per provider.** `MAX_CHAT_SESSIONS = 8`
   (`src/core/provider/idle.ts:9`) and `evictIdleSessions`
   (`src/core/provider.ts:804-816`) are global; a chat key gains an `owner` and
   eviction respects it. An owner is the host's client identity: the VS Code
   window id for the extension, and the authenticated principal (the bearer
   token's label; `default` when no token is configured) for the server.
3. **One shared store** replaces `vscode.Memento` for saved sessions, the model
   cache, sign-in flags, the visible-agent list and the global settings — see
   "One store, two gateways" below. There is no per-host namespace.
4. **Tool waits always bounded.** The bridge sets `requestTimeout = 0`
   (`src/core/bridge.ts:178`); replace with a finite per-turn wait from
   `SessionPolicy.toolWaitMs`, and clean up a request whose client disappears.
5. **Launch resolution cached.** `resolveLaunch` does a filesystem probe and a
   secret read on every model-list refresh (`src/core/provider.ts:147-151`);
   cache it and invalidate on settings/secret change.
6. **Bridge stream lifecycle.** Cap concurrent SSE streams per session, and
   drain on shutdown instead of leaving heartbeats to the GC.
7. **No orphan growth.** Audit that every map added for a chat is cleared on
   session close (today: `seenCalls`, `backgroundTasks`, `turnSinks` already
   are; the new process registry needs the same discipline).

## One store, two gateways

Both hosts are gateways to the same data. Every persisted thing — saved
sessions, checkpoints, the model cache, the last published model list, sign-in
flags, the sidebar's visible agents, per-agent settings, agent installs, the
pid registry — lives under one root:

```
<storageRoot>/                      default ~/.acp-hub, or ACP_HUB_HOME
  state.json                        the key/value store, schema-versioned
  secrets.json                      mode 0600; file backend of SecretStore
  config.json                       operator settings for the headless host
  agents/<agentId>/                 installs, logs, per-agent state
  agents/<agentId>/agents/          pid registry (already host-safe)
  prompts/<agentId>/                stored session prompts
```

Rules:

- **Same schema, same bytes.** Both hosts write the identical JSON shape; there
  is no `host: "vscode"` field and no duplicated key. A chat saved by one
  gateway is readable by the other.
- **Cross-process safe.** Writes go to a temp file in the same directory and are
  renamed into place; a monotonic `revision` field plus a short-lived lock file
  serialises read-modify-write. A reader that sees a newer `revision` reloads.
  `state.json` is small by construction (it holds indexes and hashes, not
  transcripts).
- **Changes are observed.** Each host watches the store and raises the same
  "state changed" event the sidebar already reacts to, so editing a setting in
  the browser updates the VS Code sidebar without a restart.
- **The VS Code host stops using `context.globalState`** for these keys. On
  first run it migrates the existing `acpHub.*` values into the store once,
  under a migration marker, and leaves the Memento keys in place (unused) so a
  downgrade still works.
- **Secrets** move from `SecretStorage` to the shared backend: a JSON file with
  mode `0600`, because VS Code's store cannot be read by another process and the
  two gateways must see the same keys. The VS Code host still mirrors into
  `SecretStorage` when it can, as a convenience, but the file is the source of
  truth. This is a deliberate security trade-off: it keeps API keys out of
  `state.json`, out of logs and out of the repo, and the server is
  loopback-first, but the file is only as protected as the account that owns the
  home directory. An OS-keychain backend can be added behind `SecretStore`
  without touching callers.

`storageRoot` defaults to `~/.acp-hub` (or `ACP_HUB_HOME`) for **both** hosts,
so they share everything without configuration; the extension falls back to its
global storage folder only when that path cannot be written. Pointing both at
the same folder is the intended deployment, not an option.

## The control page

The sidebar today is four pieces: a view provider (`src/sidebar/host.ts`), a
renderer (`render.ts`), a message schema (`messages.ts`) and a browser bundle
(`webview/main.ts`), wired to a ~45-line dependency object in
`extension.ts:99-140`. Those dependencies become an engine service, and the
transport becomes a host concern:

- **`engine/control/ControlService`** — one method per operation the dependency
  object exposes: agent list and cards, install and uninstall, install state,
  sign-in and sign-out, read/write a setting, read/write a global setting,
  enable/disable, usage read and refresh, visible agents.
- **`src/ui/`** — the page, unchanged in look and behaviour: `render.ts`,
  `messages.ts` and the webview entry move here. It receives state snapshots and
  sends actions over a `ControlTransport` interface:
  - VS Code: `postMessage` inside the webview view.
  - HTTP: `GET /` serves the same bundle; `GET /api/state` and
    `POST /api/action` carry the same messages over JSON; `GET /api/events`
    streams updates (SSE).
- **No host-specific code in the page.** Anything that differs — opening a
  browser, running a sign-in command — is an action the host executes and
  reports on, so a new field added to the sidebar is automatically visible in
  both.
- **Sign-in on the server.** Browser/OAuth methods surface the URL as a link in
  the page. A method that is a terminal command runs on the server: its output
  is streamed to the page in a small console panel, and typed input is forwarded
  to the process. That is the one place where the page does more than the
  webview, because the webview has VS Code's terminal.

The sidebar keeps working throughout: it becomes a transport implementation of
`ControlService`, not a second implementation of its logic.

## The HTTP host

`src/main/server.ts` — same build, second entry point:

- `GET /` — the control page: the same bundle the sidebar loads.
- `GET /api/state`, `POST /api/action`, `GET /api/events` — the control
  transport (see "The control page").
- `GET /v1/models` — one entry per agent/model, id `"<agentId>/<modelId>"`,
  because two agents can offer the same underlying model name.
- `POST /v1/chat/completions` — streaming SSE and non-streaming; `tools` and
  `tool_choice` mapped to `ToolDef[]`; `tool_calls` returned as deltas; usage
  in the final chunk.
- `GET /health` — agent states, running processes, open sessions.
- Bind `127.0.0.1` by default; `ACP_HUB_TOKEN` enables a bearer guard when the
  operator binds elsewhere, and the control page uses the same guard.
- Configuration: `<storageRoot>/config.json`, read through the same
  `ConfigReader` shape as VS Code, so `readAgentSettings` is unchanged.
- Install root: `<storageRoot>/agents/<id>` — the same root the extension uses,
  so an agent installed in one gateway is installed in both. The pid registry
  stays per root and already skips live owners
  (`src/core/processes.ts:76-100`), so the two hosts do not kill each other's
  processes.

## Migration order

Each step ships on its own and keeps the extension green.

1. **Boundary scaffolding.** Add `src/engine` and `src/hosts/vscode`, the eslint
   rules and `boundaries.test.ts`. Move files with `git mv`, no behaviour change.
2. **Neutral model.** Introduce `engine/model`, split `convert.ts` and
   `requestContext.ts`. `AcpProvider` translates at the edge.
3. **Host port.** Move Copilot prompt scraping, `_conversationId`, the identity
   patterns, `publishModels` and the settings read behind `HostPort`. This is
   the step that makes the engine runnable without VS Code; a fake host in
   tests proves it.
4. **`ChatService` extraction.** Move the session/reuse/fork/idle logic out of
   `AcpProvider` into `engine/chat`.
5. **`SessionPolicy`.** Replace the quirk flags with adapter-implemented
   behaviour, delete the dead hooks, add the conformance suite.
6. **The shared store.** `engine/store`, the `StateStore`/`SecretStore` ports,
   the file backend with lock and revision, and the one-time migration off
   `globalState` and `SecretStorage`. Both hosts now point at
   `~/.acp-hub`.
7. **`ControlService` and `src/ui`.** Lift the sidebar's dependency object into
   the engine and move the page into `src/ui`; the VS Code view becomes a
   transport. No visual change.
8. **The remaining scalability items** (process registry, per-owner quotas,
   launch cache, tool waits, bridge streams), as separate commits with tests.
9. **HTTP host** and `src/main/server.ts`: the control page first (it needs no
   agent), then `/v1/models` and `/v1/chat/completions`, with an end-to-end test
   over a fake ACP agent and a real HTTP client.
10. **Optional:** move `engine` into `packages/core` if a separate npm package
    is ever wanted. Nothing should need to change but paths.

Steps 1–5 are enabling work with no user-visible change; 5 is the one the
"adapter behaviour stays in the adapter" requirement is judged on; 6–7 are what
make the browser page a carbon copy rather than a second UI.

## Decided in conversation

- Continue as a VS Code extension; the server is a second host, not a fork.
- Approach A (ports-first, in place).
- Work happens on `refactor/two-host-core`.
- **The two hosts share one store.** All persisted agent data is byte-for-byte
  the same for both, in one central location, with no per-host duplication or
  namespacing. Either gateway can pick up what the other stored.
- **The browser page is a carbon copy of the sidebar.** Everything visible and
  controllable there is visible and controllable in the page, and a UI change
  is made once and appears in both.

## Calls I made (check these while reading)

- **The HTTP client executes tools.** The endpoint returns `tool_calls`; the
  caller runs them and re-posts results. The server never executes a caller's
  shell commands or edits files. Reason: it is what OpenAI clients expect, it
  reuses the existing continuation machinery, and it keeps the server's safety
  surface equal to "run a local agent", which is what it already does.
- **Model ids are `<agentId>/<modelId>`** so two agents offering the same model
  name cannot collide.
- **The server is single-user and loopback-first**, with a bearer token as the
  only multi-client guard. Anything more is a different product.
- **`src/core` is moved, not kept as a compatibility layer.** A shim would let
  the old import graph survive the refactor, which is how the coupling would
  come back.
- **`x-chat-id` and `x-acp-cwd` are optional.** Without them the HTTP host uses
  the content fingerprint described above and the configured default workspace,
  so stock OpenAI clients work unmodified.
- **The boundary allow-list includes `engine/acp/protocol`** (types only), so
  adapters can keep naming ACP protocol types without reaching into the client.
- **`owner` and `workspaceRoot` mean what item 2 and item 1 of the scalability
  section say**; the registry's location and eviction policy are left open.
- **Shared storage is the default, not a mode.** Both hosts use
  `~/.acp-hub` (or `ACP_HUB_HOME`) unless told otherwise; the extension's
  `globalStorage` is only a fallback when that path is unwritable, and its old
  Memento values are migrated once.
- **Secrets move to a `0600` file in that store**, because `SecretStorage`
  cannot be read by the second process and the two gateways must see the same
  keys. `SecretStorage` remains a best-effort mirror. This is a deliberate
  security trade-off, recorded above.
- **The server runs terminal sign-in commands and streams their output** to the
  page, with typed input forwarded. Browser/OAuth methods surface their URL as
  a link. That is the only place the page does more than the webview.
- **The shared store is the only writer of persisted chat state**; neither host
  keeps a private copy, so `state.json` carries a `revision` and a lock rather
  than per-host files.

## Left to the builder

- Exact `HostPort` method names and whether `executeTool` returns a value or a
  promise resolved by a later request (the latter is what both hosts need).
- How a `ChatRequest` maps to the existing `ChatSession` reuse keys without
  changing fork behaviour; the existing fingerprints stay the source of truth.
- Where the per-workspace process registry lives (engine vs `AgentClient`) and
  its eviction policy.
- The precise sequencing inside step 3 so the extension's smoke tests keep
  passing while the prompt scraping moves.
- The shape of `state.json` (one document vs one file per key) and whether the
  lock is a lock file or an OS advisory lock.
- How much of the webview's CSS is reusable as-is in the page, and whether the
  page ships as a second esbuild entry or the same bundle plus a shell.
