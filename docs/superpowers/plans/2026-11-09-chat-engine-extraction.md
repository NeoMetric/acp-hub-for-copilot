# Chat Engine Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the chat pipeline out of VS Code behind a neutral model and a host port, so the same code can serve a second host, without changing the extension's behaviour.

**Architecture:** `src/engine` holds the neutral chat model, the ports a host implements, the ACP transport and the chat use case. `src/hosts/vscode` holds everything that knows Copilot and VS Code — including the prompt scraping that recovers chat identity, cwd and guidance. `AcpProvider` becomes a translator at the edge.

**Tech Stack:** TypeScript, esbuild, vitest, eslint. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-two-host-core-design.md` (sections "Target architecture", "The neutral model", "The host port", "The use case").

## Global Constraints

- `src/engine/**` must contain **zero** `import ... from 'vscode'`. A boundary test enforces it from Task 1.
- The extension's behaviour must not change. `test/unit/forkChats.test.ts` (35 tests) and `test/unit/convert.test.ts` are the equivalence proofs.
- No `src/core` file may contain an agent id, vendor or display-name comparison.
- Tabs, single quotes, existing comment idiom, no new dependencies, no file renames outside the moves each task names.
- Every task ends with `npx tsc -p . --noEmit`, `npm run lint` and `npm test` green.

## Review Focus

- **A request with no `_conversationId`.** Chat identity must still be stable across turns, or every turn opens a new session and the prompt cache is lost.
- **A workspace with two folders**, where the chat is rooted in the second. The agent must be started in the chat's folder, not the window's first.
- **A provider request that arrives while the engine is disposing.** No session may be created after shutdown, and no promise may reject unhandled.
- **A host that supplies no `publishModels`.** The engine must not call it, and models must still be listed.
- **A tool call whose result arrives on a later request.** The turn must survive the boundary in both hosts.

---

### Task 1: The engine's neutral model and ports

**Files:**
- Create: `src/engine/model/chat.ts`, `src/engine/model/stream.ts`
- Create: `src/engine/ports/host.ts`, `src/engine/ports/state.ts`
- Create: `test/unit/engine/boundaries.test.ts`
- Create: `test/unit/engine/model.test.ts`

**Interfaces:**
- Produces: `Part`, `ChatMessage`, `ChatRole`, `ToolDef`, `ChatRequest`, `StreamEvent`, `ToolResult`; `HostPort`, `StateStore`, `SecretStore`, `ConfigReader`, `ChatIdentity`; `assertEngineIsHostFree()` in the boundary test.

- [ ] **Step 1: Write the boundary test first**

`test/unit/engine/boundaries.test.ts` walks `src/engine` and asserts no file matches `/from 'vscode'/`, and that the directory exists. It must fail because the directory does not exist yet.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/engine/boundaries.test.ts`
Expected: FAIL — `src/engine` does not exist.

- [ ] **Step 3: Write the model**

```ts
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export type Part =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: Uint8Array; readonly mimeType: string }
	| { readonly type: 'tool-call'; readonly callId: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'tool-result'; readonly callId: string; readonly content: readonly Part[]; readonly isError?: boolean };
export interface ChatMessage { readonly role: ChatRole; readonly parts: readonly Part[]; readonly name?: string }
export interface ToolDef { readonly name: string; readonly description: string; readonly inputSchema: unknown }
export interface ChatRequest {
	readonly chatId: string;
	readonly cwd: string;
	readonly messages: readonly ChatMessage[];
	readonly tools: readonly ToolDef[];
	readonly model?: string;
	readonly effort?: string;
	readonly systemGuidance?: string;
}
export type StreamEvent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'thought'; readonly text: string }
	| { readonly type: 'tool-call'; readonly callId: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'usage'; readonly promptTokens: number; readonly cachedTokens: number; readonly outputTokens: number }
	| { readonly type: 'done'; readonly stopReason: string }
	| { readonly type: 'error'; readonly message: string };
export interface ToolResult { readonly content: readonly Part[]; readonly isError?: boolean }
```

- [ ] **Step 4: Write the ports**

`ports/state.ts`: `StateStore { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void>; keys(): readonly string[] }`, `SecretStore { get(id: string): Promise<string | undefined>; set(id: string, value: string): Promise<void>; delete(id: string): Promise<void> }`, `ConfigReader { get<T>(section: string): T | undefined }`.

`ports/host.ts`: `HostPort` with `log`, `state`, `secrets`, `settings`, `storageRoot`, `chatIdentity(request: ChatRequest): ChatIdentity`, `guidanceOf(request: ChatRequest): string | undefined`, `executeTool(call, signal): Promise<ToolResult>`, `ui`, and optional `publishModels`. `ChatIdentity { readonly id: string; readonly cwd: string; readonly workspaceFolders: readonly string[] }`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/engine/boundaries.test.ts test/unit/engine/model.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine test/unit/engine
git commit -m "feat(engine): add the neutral chat model and host ports"
```

---

### Task 2: Move the ACP transport into the engine

**Files:**
- Move: `src/core/rpc.ts` → `src/engine/acp/rpc.ts`
- Move: `src/core/protocol.ts` → `src/engine/acp/protocol.ts`
- Move: `src/core/agentClient.ts` → `src/engine/acp/agentClient.ts`
- Create: `src/engine/acp/emitter.ts` (a local `Emitter<T>` and `Disposable`)
- Modify: `src/core/processes.ts` (re-export `processHost` helpers if needed)

**Interfaces:**
- Consumes: `HostPort` from Task 1 (only `log`).
- Produces: `AgentClient`, `AgentSession`, `AcpTokenUsage`, `RpcError` from `src/engine/acp/*`; `Emitter<T>` with `event` and `fire`.

- [ ] **Step 1: Add the failing test**

Extend `test/unit/engine/boundaries.test.ts` with a case asserting `src/engine/acp/agentClient.ts` exists and that `AgentClient` can be constructed with a fake `Log` and a fake `LaunchContext`, with no `vscode` in scope.

- [ ] **Step 2: Move the files and replace the two VS Code usages**

`agentClient.ts` uses `vscode.Disposable` and `vscode.EventEmitter`. Replace with `emitter.ts`. All other references to `./rpc`, `./protocol`, `./processes` are re-pointed. `src/core/*` files that imported them get re-exports from the old paths only if a file outside the engine still needs them; prefer updating the import.

- [ ] **Step 3: Run the transport tests unchanged**

Run: `npx vitest run test/unit/agentClient.test.ts test/unit/rpc.test.ts test/unit/protocol.test.ts test/unit/engine/boundaries.test.ts`
Expected: PASS with no edits to the existing assertions.

- [ ] **Step 4: Commit**

```bash
git add src/engine src/core test/unit
git commit -m "refactor(engine): move the ACP transport out of core"
```

---

### Task 3: Move the pure engine modules

**Files:**
- Move: `src/core/cache.ts`, `src/core/sessionStore.ts`, `src/core/sessionFingerprint.ts`, `src/core/usage.ts`, `src/core/systemPrompt.ts` (the parts that need no `vscode`) → `src/engine/chat/`

**Interfaces:**
- Produces: the same export names from their new paths; `SavedSessionStore` takes `StateStore` instead of `vscode.Memento`.

- [ ] **Step 1: Write the failing test** — the boundary suite gains a case for each moved module.
- [ ] **Step 2: Move and re-point** — `SavedSessionStore`'s constructor changes from `Memento` to `StateStore`; its call sites pass one.
- [ ] **Step 3: Run the tests** — `sessionStore`, `cache`, `usage`, `systemPrompt`, `checkpoints` unchanged.
- [ ] **Step 4: Commit** — `refactor(engine): move the pure chat modules out of core`.

---

### Task 4: `ChatService` — the use case

**Files:**
- Create: `src/engine/chat/ChatService.ts`
- Create: `src/engine/chat/types.ts` (moved from `src/core/provider/types.ts`, minus `vscode`)
- Create: `test/unit/engine/chatService.test.ts`

**Interfaces:**
- Consumes: `HostPort`, `AgentClient`, `SavedSessionStore`, `McpBridge` (moved to `src/engine/mcp/bridge.ts`).
- Produces: `ChatService` with `respond(request: ChatRequest, sink: (event: StreamEvent) => void, signal: AbortSignal): Promise<void>`, `close()`, `warm()`, `usage()`. Emits `StreamEvent`s; never touches `vscode`.

- [ ] **Step 1: Write the failing test** — a fake host plus the mock ACP agent: send a `ChatRequest`, assert `text` then `done`; a second request with the same `chatId` resumes the same session.
- [ ] **Step 2: Extract** — port `provider.ts`'s session map, idle sweep, reuse decision and turn runner into `ChatService`; the provider keeps only VS Code translation.
- [ ] **Step 3: Run** — `forkChats.test.ts` must pass, now driving `ChatService` through the provider.
- [ ] **Step 4: Commit** — `feat(engine): add ChatService`.

---

### Task 5: The VS Code host

**Files:**
- Create: `src/hosts/vscode/host.ts`, `src/hosts/vscode/identity.ts` (the prompt scraping from `requestContext.ts`)
- Modify: `src/core/provider.ts` to be a thin adapter, `src/extension.ts` to construct the host

- [ ] **Step 1: Failing test** — `test/unit/engine/boundaries.test.ts` asserts `src/core/provider.ts` no longer reads `modelOptions._conversationId` and that the scraper lives in `src/hosts/vscode`.
- [ ] **Step 2: Move and wire.**
- [ ] **Step 3: Run the full suite.**
- [ ] **Step 4: Commit** — `refactor(host): give VS Code its own host port`.

---

## Self-Review

**Spec coverage:** implements design steps 1–4 (engine, neutral model, host port, `ChatService`) and the boundary rules. Steps 6–9 (shared store, control page, scalability, HTTP host) are separate plans.

**Type consistency:** `HostPort`, `ChatRequest`, `StreamEvent` and `ChatService.respond` are defined once, in Tasks 1 and 4, and named identically afterwards.

**Review Focus coverage:** chat identity without `_conversationId` → Task 5's scraper test; two-folder workspace → `resolveCwd` retained in the host; dispose during a request → Task 4's `close()` test; missing `publishModels` → Task 1's optional member, exercised by the fake host; tool result on a later request → Task 4's two-request test.
