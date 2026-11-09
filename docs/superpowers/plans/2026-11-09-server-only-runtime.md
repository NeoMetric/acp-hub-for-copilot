# Server-only Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension stops running agents; the server process is the only place they run, the extension's three model providers and its sidebar are thin clients of it, and the extension starts (or attaches to) that server.

**Architecture:** The HTTP surface (`src/hosts/http`) grows the few things the picker and chat need (model metadata, images, thinking, request extras, health identity). A new `ServerLink` in the extension probes `/health`, attaches, or spawns the bundled server tied to the extension host's stdin pipe. Three `ServerProvider`s (one per agent) translate VS Code's chat API to `/v1/chat/completions`; the sidebar keeps its `postMessage` webview and a `SidebarRelay` forwards its actions to `/api/*`. Once that works, the in-host engine path is deleted.

**Tech Stack:** TypeScript, Node `http`/`fetch`, VS Code extension API (`LanguageModelChatProvider`, webview), vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-09-server-only-runtime-design.md`

## Global Constraints

- Windows is the tested platform; child-process and shutdown handling must not rely on POSIX signals alone.
- Only the extension host talks to the server's `127.0.0.1`; the webview never does (it must work in Remote-SSH/WSL/Codespaces windows).
- `src/engine/**` imports no `vscode`; the server (`src/hosts/http`, `src/main`, `src/composition`) contains nothing named after VS Code. VS Code-specific context reaches the server as generic request fields.
- **Honour the adapter design pattern** (owner's instruction): an adapter's behaviour lives in the adapter (`src/adapters/*`, `AgentAdapter`, `ModelPolicy`, session policy). The server, the extension, the providers, the relay and the engine never branch on an agent's id, name or on a combination of adapter flags; they call what the adapter exposes. New per-agent knowledge goes on the adapter interface, with `test/unit/noAgentBranching.test.ts` and `test/unit/adapters/conformance.test.ts` staying green. Agent ids and vendor names are read from the registry/adapters, never hard-coded in extension code.
- Three providers, one per agent (vendors `Claude Agent`, `Codex Agent`, `Google Agent`), as on `main`. Model ids on the wire are `<agentId>/<modelValue>`; `owned_by` is the agent id.
- Default port 8791 (overridable by a setting); a bearer token persisted in the shared store; server loopback-only.
- The shared store layout does not change.
- Settings: the sidebar and `<root>/config.json` are the only home of agent settings. The `acpHub.agents.*` VS Code settings are removed. The extension keeps only its own settings (server port, whether to start a bundled server).
- No in-host fallback path, no setting that re-enables it.
- `npm run typecheck`, `npm run lint`, `npm test` and `npm run generate:check` stay green at the end of every task.
- Every commit message ends with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## Review Focus

Failure modes the spec implies but no spec section tests; each line has its test in the named task.

1. **Server dies mid-turn or between turns** (window 1 closed under window 2): the provider throws a readable `LanguageModelError`, never hangs, and the next message starts a server of its own. (Task 7, Task 9)
2. **Model list while the server is down or cold at startup**: the picker keeps the last-known models instead of emptying; a cold `/v1/models` answers from cache and refreshes in the background. (Task 3, Task 7)
3. **Non-ASCII or space-containing workspace path** (Windows `C:\Users\Ünal Ö\my repo`): travels in the JSON body, not a header, and arrives byte-identical. (Task 4)
4. **A large pasted image** (about 10 MB): the request is accepted and the image reaches the engine as an image part. (Task 4)
5. **Another process on port 8791 / wrong token / old server without `apiVersion`**: never killed or restarted; the providers show a readable message naming the port or the token file. (Task 5)

---

### Task 0: Branch and clean starting point

**Files:** none changed besides git state.

- [ ] **Step 1: Check what is uncommitted**

Run: `git status --short`
Expected: lists the owner's uncommitted edits (at planning time: `.vscode/launch.json`, `src/composition/headless.ts`, `src/engine/control/ControlService.ts`, `src/extension.ts`, `src/hosts/http/server.ts`, `src/ui/controlPage.ts`, `test/fixtures/mock-acp-agent.cjs`, `test/unit/controlService.test.ts`, `test/unit/server.test.ts`, plus untracked `scripts/sync-copilot-models.ps1`, `test/unit/controlPage.test.ts`). These are the owner's work. Do not commit them in this plan's commits and never use `git add -A` / `git add .`. Ask the owner to commit or stash them before Task 1 starts; if they say to continue anyway, stage only the paths each task names.

- [ ] **Step 2: Create the branch from the current branch**

Run: `git switch -c feat/server-only-runtime`

- [ ] **Step 3: Baseline**

Run: `npm run typecheck; npm run lint; npm test`
Expected: all green. If not, stop and report which fail before changes.

- [ ] **Step 4: Commit the spec and this plan**

```powershell
git add docs/superpowers/specs/2026-11-09-server-only-runtime-design.md docs/superpowers/plans/2026-11-09-server-only-runtime.md
git commit -m "docs: design and plan for the server-only runtime"
```

---

### Task 1: Wire contract and health identity

**Files:**
- Create: `src/hosts/http/wire.ts` (types and constants only, no Node or VS Code imports; the extension imports it too)
- Modify: `src/hosts/http/server.ts` (`sendHealth`)
- Test: `test/unit/engine/wire.test.ts` (new file; reuse the server-start helper pattern from `test/unit/server.test.ts` and `test/unit/engine/httpHost.test.ts`)

**Interfaces:**
- Produces, all exported from `wire.ts`:
  - `SERVER_NAME = 'acp-hub'`, `API_VERSION = 1`
  - `interface HealthWire { status: 'ok'; name: typeof SERVER_NAME; version: string; apiVersion: number; openSessions: number; agents: Array<{ id: string; installed: boolean; openSessions: number }> }`
  - `interface EffortWire { value: string; label: string; description: string }`
  - `interface ModelInfoWire { name: string; family: string; version: string; detail?: string; tooltip?: string; maxInputTokens: number; maxOutputTokens: number; toolCalling: boolean; imageInput: boolean; efforts: EffortWire[]; defaultEffort?: string; effortTitle?: string; effortDescription?: string }`
  - `interface ModelWire { id: string; object: 'model'; owned_by: string; acp?: ModelInfoWire }`
  - `interface AcpRequestExtras { chatId?: string; label?: string; cwd?: string; workspaceFolders?: string[]; systemGuidance?: string; chatContext?: string; promptsDir?: string }` (sent as the `acp` field of the chat body)

- [ ] **Step 1: Write the failing test** `health reports the server identity`: start the server over the test composition used by `server.test.ts`, `GET /health`, assert `name === 'acp-hub'`, `apiVersion === API_VERSION`, `typeof version === 'string'` and the existing `status`, `openSessions`, `agents` fields are still present.
- [ ] **Step 2: Run** `npx vitest run test/unit/engine/wire.test.ts` — expect FAIL (`name` undefined).
- [ ] **Step 3: Create `wire.ts`** with the interfaces above, and make `sendHealth` return a `HealthWire`; `version` is read from the package version (`process.env.npm_package_version` is not reliable in a bundle: use an esbuild `define` of `__ACP_HUB_VERSION__` set from `package.json` in `esbuild.js`, with `'dev'` as the fallback when undefined).
- [ ] **Step 4: Run** the test again plus `npx vitest run test/unit/server.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(server): health names the server and its api version` (stage only `wire.ts`, `server.ts` hunks of this task, `esbuild.js`, the new test).

---

### Task 2: Wire the engine options the headless composition lacks

The extension passes `ChatService` options that `createHeadlessComposition` does not: `buildSessionPrompt`, `transcriptOptions`, `dumpRequest`, `refineWindow`, `finished`, `measured`, `signInRequired`, `agentChanged`. Without them the server loses customization-file guidance, resume-transcript settings, usage/cache accounting for the sidebar, and sign-in expiry. They must work in the server before the extension stops doing it.

**Files:**
- Modify: `src/composition/headless.ts`
- Modify: `src/core/systemPrompt.ts` (imports `vscode` at runtime; see Step 3), `src/core/convert.ts` (`readTranscriptOptions` reads VS Code settings)
- Test: `test/unit/engine/headlessWiring.test.ts` (new)

**Interfaces:**
- Consumes: `ChatServiceDeps` in `src/engine/chat/ChatService.ts`; `UsageStore` (`recordTurn`, `recordRequest`) in `src/engine/chat/usage.ts`; `ControlService` (`refreshUsage`, `reportSignInUrl`).
- Produces: `createHeadlessComposition` options gain `readonly promptsDir?: string` (the folder of user customization prompts, default none); the composition's `ChatService`s are built with all options above.

- [ ] **Step 1: Write failing tests** in `headlessWiring.test.ts` using the mock ACP agent fixture (`test/fixtures/mock-acp-agent.cjs`, see how `test/unit/engine/chatService.test.ts` drives a service over it):
  - `a finished turn is recorded in usage`: after one `respond`, `composition.control.state()` shows the agent's usage recorded a turn (assert via the `UsageStore` the composition exposes: add `readonly usage: UsageStore` to `HeadlessGateways`).
  - `transcript detail is read from config.json`: set `acpHub.resume.transcriptDetail` to `full` through `host.writeSetting`, assert the options the service uses report `full`.
  - `a refused request for lack of credentials marks the agent signed out`: with the fixture refusing auth, assert `state['signedIn.<id>']` becomes `false`.
- [ ] **Step 2: Run** `npx vitest run test/unit/engine/headlessWiring.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Make `src/core/systemPrompt.ts` free of runtime `vscode` imports (inspect what it uses `vscode` for, port to `node:fs`/types only); `readTranscriptOptions` takes a `ConfigReader` instead of calling `vscode.workspace.getConfiguration`. In `headless.ts` pass `buildSessionPrompt` (using `options.promptsDir`), `transcriptOptions: () => readTranscriptOptions(host.settings)`, `dumpRequest` (a no-op until Task 4 adds the request dump setting; leave as a named known loss per the spec), `refineWindow` (store in a map that Task 3 reads), `finished: turn => usage.recordTurn(adapter.id, adapter.reportsCache === false ? undefined : turn.usage, turn.background)` plus `control.refreshUsage(adapter.id, false)` when `adapter.usage && !adapter.usage.onDemandOnly && !turn.background`, `measured: m => usage.recordRequest(adapter.id, m)`, `signInRequired: () => host.state.update('signedIn.<id>', false)` then `control.refresh()`-equivalent so the page redraws. Mirror what `src/extension.ts` does in its `provider.onDidFinishTurn`, `onDidMeasureRequest`, `onDidRequireSignIn` handlers today.
- [ ] **Step 4: Run** the new tests, `npx vitest run test/unit/boundaries.test.ts test/unit/engine/boundaries.test.ts test/unit/systemPrompt.test.ts test/unit/convert.test.ts`, then `npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(server): wire usage, session prompt and transcript settings into the headless composition`.

---

### Task 3: Rich, cached `/v1/models`

**Files:**
- Create: `src/core/modelInfo.ts` — `modelInfosOf(adapter: AgentAdapter, session: AgentSession, reportedWindows: ReadonlyMap<string, number>): Array<{ value: string; info: ModelInfoWire }> | undefined`
- Modify: `src/hosts/http/server.ts` (`sendModels`, `modelIdsOf`/`modelOptionOf`/`valuesOf` are replaced by it), `src/composition/headless.ts` (reported windows map from Task 2's `refineWindow`; model cache in `host.state` under `acpHub.models.<agentId>`), `src/core/models.ts` (reuse `findModelOption`, `flattenChoices`, `effortLevelsOf`)
- Test: `test/unit/engine/modelsWire.test.ts` (new)

**Interfaces:**
- Consumes: `ModelInfoWire`, `ModelWire` (Task 1); `AgentAdapter.modelPolicy` (`familyOf`, `contextWindowOf`, `maxOutputTokens`, `detail`, `fallbackTooltip`, `thinkingDescription`, `effortLabel`, `effortDescription`, `defaultEffort`) and `adapter.listModels` as `modelsOfSession` in `src/core/provider/modelList.ts` uses them today.
- Produces: `GET /v1/models` entries carry `acp: ModelInfoWire` with exactly what `toModelInformation` in `src/core/models.ts` puts on a `LanguageModelChatInformation` today: `name`, `family`, `version: '1'`, `detail`, `tooltip`, `maxInputTokens = contextWindow - maxOutputTokens` (using the reported window when known), `maxOutputTokens`, `toolCalling: true`, `imageInput: true`, `efforts`, `defaultEffort`, `effortTitle: 'Thinking Effort'`, `effortDescription: policy.thinkingDescription`.

- [ ] **Step 1: Write failing tests** in `modelsWire.test.ts` over the mock agent:
  - `models carry the picker metadata`: entry for `<agent>/<model>` has `acp.name`, `acp.maxInputTokens + acp.maxOutputTokens === policy window`, `acp.efforts` equals the effort levels the fixture reports with `label`/`description` from the policy.
  - `a cold model list answers from the saved copy`: pre-seed `state['acpHub.models.<agent>']`, make the warm session hang; assert the response returns the seeded models within 1 s and that the agent's real list replaces the seed afterwards.
  - `an agent that is not installed lists no models` (existing behaviour kept).
  - `a reported context window narrows maxInputTokens` after `refineWindow(model, size)` was called.
- [ ] **Step 2: Run** `npx vitest run test/unit/engine/modelsWire.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `modelInfosOf` by extracting the model-choice logic of `modelsOfSession` (`src/core/provider/modelList.ts`) into this vscode-free module; `sendModels` serves the saved list at once when there is one and refreshes it in the background (single-flight per agent), and reads from the warm session otherwise.
- [ ] **Step 4: Run** the new tests plus `npx vitest run test/unit/models.test.ts test/unit/server.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(server): list models with picker metadata, served from a cache`.

---

### Task 4: Chat request extras, images, thinking and usage over the wire

**Files:**
- Modify: `src/hosts/http/server.ts` (`complete`, `chatRequestOf`, `partsOf`, `gather`, `stream`, `usageOf`, `MAX_BODY_BYTES` raised to `32 * 1024 * 1024`), `src/hosts/http/host.ts` (`rememberHeaders` becomes `rememberExtras`; `identityOf`, `guidanceOf`, `chatWideContextOf` read the extras)
- Test: `test/unit/engine/chatWire.test.ts` (new)

**Interfaces:**
- Consumes: `AcpRequestExtras` (Task 1); `StreamEvent` types `text`, `thought`, `tool-call`, `usage` (with `reasoningTokens`), `done`, `error` in `src/engine/model/stream.ts`.
- Produces on the wire:
  - request: top-level `reasoning_effort` → `ChatRequest.effort`; `acp: AcpRequestExtras` → `chatId`, `cwd`, `workspaceFolders` (into `ChatIdentity.workspaceFolders`), `label`, `systemGuidance`, `chatContext` (returned by the host's `chatWideContextOf`), `promptsDir` (passed to the session prompt builder of Task 2 per request). Precedence: `acp.*` over headers `x-chat-id`/`x-acp-cwd` over derived values.
  - images: a content part `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }` in user messages **and** in `tool` messages becomes `{ type: 'image', data, mimeType }` (tool messages with array content keep their text and image parts inside the tool-result's `content`).
  - streaming: `thought` events become `delta.reasoning_content`; non-streaming responses add `message.reasoning_content`.
  - final usage adds `completion_tokens_details: { reasoning_tokens }`.
- The server's host applies `stripIdentity` (`src/core/identityPatterns.ts`) to `systemGuidance` in `guidanceOf`, as the VS Code host does today.

- [ ] **Step 1: Write failing tests** in `chatWire.test.ts` (mock agent; capture the `ChatRequest` the service receives via a spy `ChatService.respond`):
  - `acp extras name the chat, folder and guidance` — including `cwd: 'C:\\Users\\Ünal Ö\\my repo'` arriving byte-identical (Review Focus 3).
  - `acp.chatId wins over x-chat-id`.
  - `reasoning_effort reaches the engine as effort`.
  - `an image part reaches the engine as an image` with a ~10 MB base64 payload (Review Focus 4), in a user message and in a tool message.
  - `thinking streams as reasoning_content` and `usage carries reasoning_tokens`.
  - `a stock client with no extras still works` (existing `server.test.ts` cases stay green).
- [ ] **Step 2: Run** `npx vitest run test/unit/engine/chatWire.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the mapping in `server.ts`/`host.ts` as specified above.
- [ ] **Step 4: Run** `npx vitest run test/unit/engine test/unit/server.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(server): carry chat context, images and thinking over chat completions`.

---

### Task 5: `ServerLink` — attach, spawn, takeover; the server exits with its parent

**Files:**
- Create: `src/hosts/vscode/serverLink.ts` (no runtime `vscode` import; uses a small typed listener set so vitest can run it)
- Create: `src/main/parent.ts` — `exitWithParent(stdin: NodeJS.ReadableStream, stop: () => void): void`
- Create: `src/main/token.ts` — `tokenFileOf(root: string): string` (`<root>/server.token`), `readToken(root: string, env: NodeJS.ProcessEnv): string | undefined` (env `ACP_HUB_TOKEN`, else the file's trimmed contents, else `undefined`), `ensureToken(root: string): string` (creates the file with `randomBytes(24).toString('hex')` when absent, mode 0600 where supported)
- Modify: `src/main/server.ts` (token from `readToken`; honour `--exit-with-parent`)
- Create: `test/fixtures/stub-server.cjs` (an HTTP server answering `/health` with the `HealthWire` shape, port from `ACP_HUB_PORT`, exits when stdin closes if `--exit-with-parent`)
- Test: `test/unit/serverLink.test.ts`, `test/unit/parent.test.ts`, `test/unit/token.test.ts` (all new)

**Interfaces:**
- Consumes: `HealthWire`, `API_VERSION`, `SERVER_NAME` (Task 1).
- Produces:
  - `type ServerEndpoint = { readonly baseUrl: string; readonly token?: string }`
  - `type LinkState = { readonly kind: 'ready'; readonly endpoint: ServerEndpoint; readonly owned: boolean } | { readonly kind: 'unavailable'; readonly reason: string }`
  - `interface ServerLinkDeps { root: string; port: number; autoStart: boolean; serverScript: string; extensionDir: string; log: Log; spawn?: typeof import('node:child_process').spawn; fetch?: typeof fetch; retryMs?: number }`
  - `class ServerLink { constructor(deps: ServerLinkDeps); ensure(): Promise<LinkState>; readonly state: LinkState | undefined; onDidChange(listener: (state: LinkState) => void): () => void; dispose(): Promise<void> }`
  - `ensure()` is single-flight and idempotent: probe `GET /health` (no token); classify as `absent` (connection refused), `compatible` (`name === 'acp-hub'` and `apiVersion === API_VERSION`), or `incompatible` (anything else, with the reason); `compatible` → verify the token with an authenticated call (`GET /v1/models`), 401 → unavailable with a message naming `tokenFileOf(root)`; `absent` and `autoStart` → `ensureToken`, spawn `process.execPath [serverScript, '--exit-with-parent']` with `ELECTRON_RUN_AS_NODE=1`, `ACP_HUB_PORT`, `cwd: extensionDir`, `stdio: ['pipe','ignore','pipe']`, `windowsHide: true`, wait for a compatible `/health` (timeout 15 s); a spawn whose child exits with `EADDRINUSE` in stderr re-probes and attaches; never signals a server it did not spawn; `dispose()` closes the child's stdin then kills it after 2 s.
  - A failed request or a periodic probe (30 s, unref'd) that finds the server gone calls `ensure()` again (this is "takeover": the window starts a server of its own, never adopts a running one).

- [ ] **Step 1: Write failing tests**
  - `parent.test.ts`: `exitWithParent calls stop when stdin ends`, and `does nothing while stdin stays open` (use `PassThrough`).
  - `token.test.ts`: `readToken prefers the environment over the file`; `ensureToken creates the file once and returns the same token twice`; `readToken is undefined with neither`.
  - `serverLink.test.ts` (uses `test/fixtures/stub-server.cjs` on a free port):
    - `attaches to a compatible server without spawning` (spy `spawn` not called, `owned: false`).
    - `spawns when nothing answers and reports owned: true`.
    - `two links race on one port: both end ready, exactly one owns` (Review Focus 5).
    - `a non-ACP server on the port is unavailable and never signalled`; `an old server without apiVersion is unavailable with a readable reason`; `a 401 names the token file`.
    - `takes over when the owner's server dies`: window A owns, window B attached; kill A's child; B's next `ensure()` spawns its own and reports `owned: true` (Review Focus 1).
    - `dispose stops an owned server and leaves an attached one running`.
    - Parent-exit end to end: spawn the stub with `--exit-with-parent`, destroy the parent's end of stdin, assert the child exits within 3 s.
- [ ] **Step 2: Run** `npx vitest run test/unit/serverLink.test.ts test/unit/parent.test.ts test/unit/token.test.ts` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** `parent.ts`, `token.ts`, `serverLink.ts`, the stub and the `server.ts` changes as specified. In `server.ts`, `--exit-with-parent` calls `exitWithParent(process.stdin, () => stop('SIGTERM'))` and resumes stdin; without the flag stdin is untouched.
- [ ] **Step 4: Run** the three test files plus `npx vitest run test/unit/engine/httpHost.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(extension): a link that attaches to or starts the server`.

---

### Task 6: Thin chat client — request mapping and SSE reader

**Files:**
- Create: `src/hosts/vscode/serverClient.ts` — talks HTTP only, no `vscode` import
- Create: `src/hosts/vscode/requestMapping.ts` — VS Code messages to the wire body (imports `vscode` for part classes only)
- Test: `test/unit/serverClient.test.ts`, `test/unit/requestMapping.test.ts` (new; the second uses `test/unit/vscode-mock.ts`)

**Interfaces:**
- Consumes: `ServerEndpoint` (Task 5); wire types (Tasks 1, 3, 4); existing pure helpers `chatIdOf`, `chatLabelOf`, `chatWideContextOf`, `stripHostSections`, `systemGuidanceOf`, `workspaceFoldersOf`, `resolveCwd` from `src/hosts/vscode/identity.ts`; `effortOf` from `src/core/models.ts`; `acpModelValue` from `src/core/models.ts`.
- Produces:
  - `serverClient.ts`: `listModels(endpoint: ServerEndpoint, signal?: AbortSignal): Promise<ModelWire[]>`; `streamChat(endpoint: ServerEndpoint, body: unknown, signal: AbortSignal, onEvent: (event: WireEvent) => void): Promise<void>` where `type WireEvent = { type: 'text'; text: string } | { type: 'thought'; text: string } | { type: 'tool-call'; callId: string; name: string; input: unknown } | { type: 'usage'; usage: WireUsage } | { type: 'error'; message: string }`; tool-call deltas are assembled by `index` and emitted when complete; a non-2xx status or a stream that ends without `[DONE]` or finish reason rejects with a `ServerChatError` whose message is readable.
  - `requestMapping.ts`: `bodyOf(model: LanguageModelChatInformation, agentId: string, messages: readonly LanguageModelChatRequestMessage[], options: ProvideLanguageModelChatResponseOptions, windowFolder: string, promptsDir: string | undefined): unknown`. It mirrors `AcpProvider.toRequest` and `toChatMessage`/`toParts`/`toToolDef` in `src/core/provider.ts`: system messages and `stripHostSections` applied to outgoing text; `acp.chatContext` computed from the unstripped messages; tool-call/tool-result parts to `tool_calls` / `tool` messages; images to `image_url` data URLs; `model` is `<agentId>/<acpModelValue(model.id)>`; `reasoning_effort` from `effortOf(options)`.

- [ ] **Step 1: Write failing tests**
  - `requestMapping.test.ts`: a golden test per case from `test/unit/requestContext.test.ts` and `test/unit/convert.test.ts` fixtures — `chat id, label, folders, guidance and chat context equal what AcpProvider computed` (call the old helpers on the same messages and compare to the body's `acp`); `the ::agent suffix is dropped from the model`; `an image part becomes an image_url data URL`; `a tool result with an error becomes a tool message whose text starts with "error:"` (the server's `isErrorText` convention); `a system-only history still sends a user-less body that the server rejects clearly` is not a client concern — skip.
  - `serverClient.test.ts` against a local `http` server: `assembles streamed tool call arguments by index`; `reports thinking`; `aborts the request when the signal fires and resolves quietly`; `a connection reset mid-stream rejects with a readable message` (Review Focus 1); `a 401 rejects naming the token`.
- [ ] **Step 2: Run** `npx vitest run test/unit/serverClient.test.ts test/unit/requestMapping.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(extension): map chat requests to the server and read its stream`.

---

### Task 7: `ServerProvider` — the three per-agent providers

**Files:**
- Create: `src/hosts/vscode/serverProvider.ts`
- Create: `src/hosts/vscode/modelMapping.ts` — `modelInformationOf(agentId: string, model: ModelWire, target?: 'agent'): vscode.LanguageModelChatInformation[]`
- Test: `test/unit/serverProvider.test.ts`, `test/unit/modelMapping.test.ts` (new, with `vscode-mock.ts`)

**Interfaces:**
- Consumes: `ServerLink` (Task 5), `listModels`/`streamChat` (Task 6), `bodyOf` (Task 6), `ModelWire` (Task 3); constants `EFFORT_PROPERTY`, `AGENT_MODEL_ID_SUFFIX`, `COPILOT_CLI_SESSION_TYPE` from `src/core/models.ts`.
- Produces:
  - `modelInformationOf` returns the two entries `toModelVariants` returns today per model (plain id and `<id>::agent` with `targetChatSessionType: 'copilotcli'`), built from `ModelWire.acp` with the same `configurationSchema` (`reasoningEffort`, group `navigation`, `enum`, `enumItemLabels`, `enumDescriptions`, `default`) as `toModelInformation`.
  - `class ServerProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>, vscode.Disposable { constructor(deps: { agentId: string; vendor: string; link: ServerLink; state: StateStore; log: Log; windowFolder(): string; promptsDir?: string }); readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>; refresh(): void }`
  - `provideLanguageModelChatInformation`: waits for `link.ensure()`, lists `/v1/models`, keeps entries with `owned_by === agentId`, saves them in `state` under `acpHub.models.<agentId>`; when the server is unavailable it returns the saved list (Review Focus 2) and never an empty one if a saved list exists; fires `onDidChangeLanguageModelChatInformation` when the link becomes ready or the list changes.
  - `provideLanguageModelChatResponse`: `link.ensure()`, `bodyOf(...)`, `streamChat` with an `AbortController` aborted by the cancellation token; events become `LanguageModelTextPart`, `LanguageModelThinkingPart` (when the running VS Code has it), `LanguageModelToolCallPart`, and a `LanguageModelDataPart.json(usage, 'usage')` in the shape `AcpProvider.report` sends today; a `ServerChatError` or an unavailable link becomes `vscode.LanguageModelError` with the readable message; after a connection failure it calls `link.ensure()` so the next message finds or starts a server.
  - `provideTokenCount`: `Math.ceil(chars / CHARS_PER_TOKEN)` using `characterCountOf` from `src/core/convert.ts`.

- [ ] **Step 1: Write failing tests**
  - `modelMapping.test.ts`: `each model yields a plain and an ::agent entry`; `the effort schema matches the one AcpProvider published` (compare with `toModelInformation` output for the same policy and levels); `a model with no efforts has no configurationSchema`.
  - `serverProvider.test.ts` with a fake `ServerLink` and a local `http` stub: `lists only its own agent's models`; `keeps the saved models when the server is unavailable`; `streams text, thinking, tool calls and usage in order`; `cancellation aborts the request`; `a dropped connection throws LanguageModelError and triggers ensure()`; `a second provider for another agent does not see the first agent's models`.
- [ ] **Step 2: Run** `npx vitest run test/unit/serverProvider.test.ts test/unit/modelMapping.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(extension): per-agent providers backed by the server`.

---

### Task 8: Sidebar relay

**Files:**
- Create: `src/sidebar/relay.ts`
- Modify: `src/sidebar/host.ts` (constructs from a `ControlTransport` instead of a `ControlSurface`; `ControlPage` is no longer used here; keeps `resolveWebviewView`/`buildHtml`; drops `showSignInUrl`/`refresh`/`handleMessage`)
- Test: `test/unit/sidebarRelay.test.ts` (new), update `test/unit/sidebarHost.test.ts`

**Interfaces:**
- Consumes: `ControlAction`, `ControlState` (`src/ui/messages.ts`); `ControlTransport` (`src/ui/transport.ts`); `ServerLink` (Task 5); routes `STATE_ROUTE`, `ACTION_ROUTE`, `EVENTS_ROUTE`.
- Produces: `class SidebarRelay implements ControlTransport, Disposable { constructor(deps: { link: Pick<ServerLink, 'ensure' | 'onDidChange'>; openExternal(url: string): Promise<void>; copyToClipboard(text: string): Promise<void>; confirmUninstall(displayName: string): Promise<boolean>; log: Log; fetch?: typeof fetch }) }` with `send(action)`, `onState(listener)`.
  - State: on the first listener, read `/api/state`, then follow `/api/events` (SSE) with the bearer token; on a dropped stream or link change, reconnect (1 s then 5 s backoff) and re-read state. While the server is unavailable, `onState` delivers the last state with every agent card carrying `error: <link reason>`.
  - Actions are forwarded to `POST /api/action`, except these, handled in the extension host: `openSignInUrl` / `copySignInUrl` (use the `signInUrl` of the agent in the latest state with `openExternal` / `copyToClipboard`, then do not forward); `uninstall` (`confirmUninstall(displayName)` first, forward only if true); `ready` (re-deliver the latest state). Whenever a state arrives with a `signInUrl` for an agent that had none, `openExternal(url)` is called once (the old `ControlPage.showSignInUrl` behaviour).

- [ ] **Step 1: Write failing tests** with a local stub server speaking `/api/state`, `/api/events`, `/api/action`:
  - `delivers the state and then every pushed change`;
  - `forwards setSetting and install to /api/action with the bearer token`;
  - `uninstall is confirmed in the window first and not forwarded when declined`;
  - `openSignInUrl opens the url the state holds and is not forwarded`;
  - `a new sign-in url opens once`;
  - `reconnects after the stream drops and shows the link error meanwhile`.
  Update `sidebarHost.test.ts` for the transport-based constructor.
- [ ] **Step 2: Run** `npx vitest run test/unit/sidebarRelay.test.ts test/unit/sidebarHost.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx vitest run test/unit/controlTransport.test.ts test/unit/sidebarRender.test.ts` — expect PASS (the page bundle is untouched).
- [ ] **Step 5: Commit** `feat(extension): sidebar relays to the server's control routes`.

---

### Task 9: Cut the extension over; package the server; remove the agent settings

**Files:**
- Modify: `src/extension.ts` (rewrite), `esbuild.js`, `.vscodeignore`, `package.json` (via the generator, below), `src/core/vendors.ts` and `scripts/generate-vendors.mts` (the generated configuration no longer contains `acpHub.agents.*`; the two extension settings below are added by hand to the non-generated part), `test/unit/extension.test.ts`, `test/unit/packaging.test.ts`, `test/unit/vendors.test.ts`, `test/smoke/extension.test.ts`
- Test: `test/unit/extension.test.ts` (rewritten), `test/unit/packaging.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 7, 8; vendor names via `vendorOf(agentId)` from `src/core/vendors.ts` and `registry/` (read ids and display names without importing `ADAPTERS`, so adapter code is not bundled into the extension).
- Produces:
  - New extension settings: `acpHub.server.port` (number, default 8791) and `acpHub.server.autoStart` (boolean, default true).
  - `activate()` builds: `ServerLink` (root = `storageRoot()`, `serverScript = <extensionDir>/dist/server.js`), one `ServerProvider` per registry agent registered with `vscode.lm.registerLanguageModelChatProvider(vendor, provider)`, a `SidebarHost` over a `SidebarRelay`, the commands `acpHub.showLogs` (output channel), `acpHub.signIn` (quick pick of agents, then relay action `signIn`), `acpHub.install` (focus the sidebar), `acpHub.refreshUsage` (relay `refreshUsage` for each agent); `deactivate()` awaits `link.dispose()`. The output channel is also fed the child's stderr.
  - Build: the server bundles to `dist/server.js` (not `server-dist/`), minified in release; `.vscodeignore` stops excluding what the server needs (`dist/**` is shipped; `adapters/` manifests are shipped; confirm the `server-dist/**` ignore line is removed or kept only as a leftover). `package.json` `"server"` script points to the new path. The server finds `sidebar.js`/`sidebar.css` as today (`dist/` and `media/` siblings).

- [ ] **Step 1: Write failing tests**
  - `extension.test.ts`: `activate registers one provider per agent with the vendor names of main` (Claude Agent, Codex Agent, Google Agent); `activate does not construct an in-host ChatService` (assert `src/extension.ts` imports neither `engine/chat` nor `core/provider`: a text test like `test/unit/noAgentBranching.test.ts` does for branching); `the sidebar view is registered`; `deactivate stops an owned server`.
  - `packaging.test.ts`: `the VSIX ships dist/server.js, dist/sidebar.js, media/sidebar.css and the adapter manifests` (use `vsce ls`-equivalent logic already in the file, or read `.vscodeignore` rules).
  - `vendors.test.ts`: `generated configuration has no acpHub.agents.* keys and keeps the two server settings`.
- [ ] **Step 2: Run** `npx vitest run test/unit/extension.test.ts test/unit/packaging.test.ts test/unit/vendors.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the rewrite, build changes and generator change; run `npm run generate` to rewrite `package.json`.
- [ ] **Step 4: Run** `npm run generate:check; npm run typecheck; npm run lint; npm test` — expect PASS (tests of code deleted in Task 10 still pass because the code still exists).
- [ ] **Step 5: Commit** `feat(extension): run every agent through the server`.

---

### Task 10: Delete the in-host engine path

**Files:** delete what the extension no longer reaches; modify `eslint.config.mjs` / boundary tests as needed; update `CHANGELOG.md`, `README.md`, `docs/parity-checklist.md`, `docs/copilot-cli-gateway.md`.

- [ ] **Step 1: List what is unreachable.** Build with a metafile and diff against the tree:

```powershell
node -e "const e=require('esbuild');Promise.all(['src/extension.ts','src/main/server.ts','src/ui/main.ts','src/uninstall.ts'].map(f=>e.build({entryPoints:[f],bundle:true,write:false,metafile:true,platform:'node',external:['vscode'],outfile:'x.js',logLevel:'silent'}))).then(r=>{const used=new Set(r.flatMap(x=>Object.keys(x.metafile.inputs)));const fs=require('fs'),path=require('path');(function w(d){for(const n of fs.readdirSync(d)){const p=path.join(d,n).replace(/\\\\/g,'/');fs.statSync(p).isDirectory()?w(p):/\.ts$/.test(p)&&!used.has(p)&&console.log(p)}})('src')})"
```

Expected: a list that includes at least `src/core/provider.ts`, `src/core/provider/*`, `src/core/bridge.ts`, `src/core/convert.ts` (if only the provider used it), `src/core/requestContext.ts`/`requestDump.ts` (if unused), `src/hosts/vscode/describeRequest.ts` (if unused). Anything under `src/core` or `src/hosts/vscode` that Task 6/7 still imports is reachable and stays. Do not delete `src/uninstall.ts` or anything the list does not name.
- [ ] **Step 2: Delete** those files and the unit tests that only exercised them (`test/unit/providerEnabled.test.ts`, `forkChats.test.ts`, `bridge.test.ts` and so on: remove a test only if every import it has is deleted; tests of engine behaviour that used the provider as a harness are rewritten over `ChatService` instead — note any such case in the commit body).
- [ ] **Step 3: Run** `npm run typecheck; npm run lint; npm test; npm run generate:check` — expect PASS; fix boundary tests (`test/unit/boundaries.test.ts`) that name deleted paths.
- [ ] **Step 4: Docs.** `CHANGELOG.md`: the extension is a client of the server; agent settings now live in the sidebar and `config.json`; existing `acpHub.agents.*` values in `settings.json` are not migrated; sign-in uses the server's flow (browser URL or the command to run in a terminal), no VS Code quick pick. `README.md`: how the server starts or attaches, the port/auto-start settings, running the server by hand. `docs/parity-checklist.md`: replace "Reload window: no orphan agent processes" with "no orphan server", add the lifecycle checks of Task 11, and list the known losses (idle wake on window focus, request dump, VS Code terminal sign-in). `docs/copilot-cli-gateway.md`: change status from parked to superseded by this design.
- [ ] **Step 5: Commit** `refactor: remove the in-host engine path` and `docs: describe the server-only runtime`.

---

### Task 11: Runtime validation against the real build

**Files:** none (evidence only); add `scripts/validate-runtime.ps1` only if the owner wants it kept.

- [ ] **Step 1: Build and package.** `npm run compile` (the repo's build script; check `package.json`), then `npx vsce package --out acp-hub-for-copilot-0.0.7-server.vsix`. Expected: the VSIX lists `dist/server.js` and `adapters/*`.
- [ ] **Step 2: Server first.** Start `node dist/server.js` by hand (port 8791), open VS Code with the extension: Output "ACP Hub" says it attached; the three providers list models; close VS Code; `Get-Process node` still shows the server; `curl http://127.0.0.1:8791/health` returns `name: acp-hub`. Stop it by hand.
- [ ] **Step 3: VS Code first.** Open VS Code: the server process exists with an `--exit-with-parent` command line; send a chat message to each agent (plain reply, then a tool-using one: read a file, edit a file, run a terminal command), confirm streaming, cancel mid-reply, effort variant, image paste. Close VS Code: the server process disappears within 5 s. Repeat but end the window's extension host with `Stop-Process -Id <pid>` and confirm the server exits.
- [ ] **Step 4: Two windows.** Window 1 starts the server, window 2 attaches; close window 1; send a message in window 2: the first reply may fail with a readable error or succeed after takeover, the next one succeeds, and exactly one server process remains.
- [ ] **Step 5: Sidebar.** Install an agent from the card (progress shows), sign in (browser URL opens once), change a setting (survives a server restart in `config.json`), uninstall (modal in VS Code first), usage windows fill after a turn.
- [ ] **Step 6: Hostile conditions.** Occupy port 8791 with `python -m http.server 8791` before opening VS Code: providers show the "not compatible" message and the other process is untouched. Delete `server.token` while a token-protected server runs: the providers name the token file.
- [ ] **Step 7: Windows path.** Open a workspace whose folder has spaces and a non-ASCII character; one chat turn works and the agent's cwd is that folder.
- [ ] **Step 8: Report** results against `docs/parity-checklist.md`, with any failed item fixed or recorded as a known loss. Do not mark the work done on unit tests alone.
