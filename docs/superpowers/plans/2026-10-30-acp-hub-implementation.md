# ACP Hub for Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One VS Code extension that exposes Claude, Codex and Google ACP agents to Copilot Chat as language-model providers, with a sidebar to install, sign in, configure and monitor them.

**Architecture:** A shared core (ACP client, RPC, process supervision, session store, Copilot provider, conversion, cache, installers, sidebar host) talks only to an `AgentAdapter` interface. Each agent is one small adapter. Vendors are declared statically in `package.json`, generated from a registry manifest by a build script.

**Tech Stack:** TypeScript, esbuild, vitest, eslint, `@vscode/test-cli`, vscode `^1.105.0`, Windows first.

**Spec:** [docs/superpowers/specs/2026-10-30-acp-hub-design.md](../specs/2026-10-30-acp-hub-design.md)

## Source repos (read-only, never modify)

Referenced below as `CLAUDE/`, `CODEX/`, `GOOGLE/`:
- `CLAUDE/` = `C:\Users\cnmid\repos\claude-acp-for-copilot`
- `CODEX/` = `C:\Users\cnmid\repos\codex-acp-for-copilot`
- `GOOGLE/` = `C:\Users\cnmid\repos\google-acp-for-copilot`

Porting rule: copy the file, rename identifiers that carry an agent name, move agent-specific constants into the adapter, port its unit test next to it, and make the ported tests pass. Where the three copies differ, diff them first (`git diff --no-index`), and record the reconciliation choice in the commit message.

## Global Constraints

- Core never branches on agent id (`if (agent === 'claude')` is a failure). Differences are adapter capabilities only. Task 2 adds a lint test that greps `src/core` and `src/sidebar` for the literal ids `claude`, `codex`, `google` and fails on any hit.
- Vendor IDs: `acphub-claude`, `acphub-codex`, `acphub-google`. Settings under `acpHub.*`; per-agent settings under `acpHub.agents.<id>.*`.
- `engines.vscode`: `^1.105.0`. Windows is the tested platform; macOS/Linux designed for (platform/arch in installers, no `shell: true` where avoidable).
- Secrets in VS Code SecretStorage keyed by agent id.
- Usage appears only in the sidebar. No status bar items.
- The three source repos are not modified. No settings/chat-selection migration in v1.
- Bundled agents: only Claude, Codex, Google. Level 1 (registry-driven) is proven by a test fixture agent only.
- Shipped defaults copied from the sources: `sessions.idleTimeoutSeconds` 120, `agent.idleShutdownMinutes` 30, `permissionMode`, `authPreference`.
- Scope: local build, public repo, CI (typecheck, lint, test, package VSIX). No Marketplace publishing.
- **Code style (author's explicit instruction):** keep the code simple and dumb. Plain functions, explicit types, small files, obvious names, early returns. No clever abstractions, metaprogramming or dense one-liners. Comment only where something needs clarification.
- If the Task 1 spike fails, STOP and ask the author. The single-vendor fallback is not pre-approved.

## Review Focus

1. Agent not installed / no network at first use: the provider must report a clear "install from the ACP Hub sidebar" error, not hang (Task 11 test).
2. Two agents active at once (e.g. Claude and Codex chats): sessions, processes and idle shutdown must not cross-contaminate (Task 11 test).
3. Corrupt or invalid user settings (bad JSON in Codex config merge, negative timeouts): fail with a readable message, never crash activation (Task 5 and Task 14 tests).
4. Workspace paths with spaces or non-ASCII characters on Windows, in launch args and the Google spawn (Task 8 and Task 14 tests).
5. Agent process dies mid-request or emits garbage on stdout: request fails cleanly and the next request restarts the agent (Task 3 mock agent modes, Task 7 test).

---

## File Structure

```
package.json, tsconfig.json, esbuild.js, eslint.config.mjs, vitest.config.ts, .vscode-test.mjs
.github/workflows/ci.yml
registry/agents.json                 manifest: one entry per bundled agent
scripts/generate-vendors.mjs         manifest -> package.json contributes (+ --check)
src/extension.ts                     activation wiring only
src/core/adapter.ts                  AgentAdapter interface and related types
src/core/agents.ts                   list of adapters (the only place that imports them)
src/core/{logging,rpc,processes,npm,sessionStore,cache,requestDump,identityPatterns,customizations,convert,
          systemPrompt,requestContext,bridge,models,settings,secrets,auth}.ts
src/core/agentClient.ts              ACP client + supervision (ported agent.ts)
src/core/installers.ts               npm-package / downloaded-binary / existing-cli runners
src/core/provider.ts                 Copilot language-model provider (one instance per adapter)
src/core/usage.ts                    UsageSource types + polling store feeding the sidebar
src/adapters/{claude,codex,google,generic}.ts
src/sidebar/{host,messages}.ts, media/sidebar.{html,css,ts}
test/fixtures/mock-acp-agent.cjs, test/fixtures/fixture-agent.json
test/unit/*.test.ts, test/smoke/extension.test.ts
docs/parity-checklist.md
```

---

### Task 1: Static-vendor spike and scaffold (GATE)

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.js`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `src/extension.ts`, `LICENSE`
- Model on: `CLAUDE/package.json`, `CLAUDE/esbuild.js`, `CLAUDE/tsconfig.json`, `CLAUDE/eslint.config.*`, `CLAUDE/vitest.config.*`

**Interfaces:**
- Produces: working `npm run compile | typecheck | lint | test` scripts; an extension that registers three providers via `vscode.lm.registerLanguageModelChatProvider('acphub-claude' | 'acphub-codex' | 'acphub-google', provider)`, each returning one fake model.

- [ ] **Step 1:** Scaffold the toolchain by copying config from `CLAUDE/`, renaming package to `acp-hub-for-copilot`, `publisher` as in `CLAUDE/package.json`, `main` `./dist/extension.js`.
- [ ] **Step 2:** In `package.json` add `contributes.languageModelChatProviders` with the three vendors (`displayName` "Claude Agent", "Codex Agent", "Google Agent"), activationEvents `onStartupFinished` and `onLanguageModelChatProvider:<vendor>` for each.
- [ ] **Step 3:** Implement `activate()` registering the three vendors with a stub provider whose `provideLanguageModelChatInformation` returns one model named `<vendor> spike`, and whose response streams the text "spike ok".
- [ ] **Step 4:** Run `npm run compile` and `npm run typecheck`. Expected: both succeed.
- [ ] **Step 5 (manual, author-assisted):** F5 Extension Development Host. In Copilot Chat's model picker verify: (a) all three vendors appear as separate groups, (b) each can be selected and returns "spike ok", (c) the VS Code "Manage Models" UI lists them separately. Record findings in `docs/spike-result.md` (3 lines each).
- [ ] **Step 6: GATE.** If any of (a)-(c) fails, STOP and ask the author. Do not start Task 2.
- [ ] **Step 7: Commit** `chore: scaffold project and static-vendor spike`.

---

### Task 2: AgentAdapter interface, agent list, no-agent-branching test

**Files:**
- Create: `src/core/adapter.ts`, `src/core/agents.ts`, `test/unit/noAgentBranching.test.ts`

**Interfaces:**
- Produces in `adapter.ts` (exact shape other tasks rely on):

```ts
export type InstallSpec =
  | { kind: 'npm'; packageName: string; version: string; entryFile?: string }
  | { kind: 'download'; downloader: (ctx: InstallContext) => Promise<string> } // returns executable path
  | { kind: 'existing-cli'; command: string };
export interface InstallContext { storageDir: string; log: Log; progress(message: string): void }
export interface LaunchContext { installDir: string; settings: AgentSettings; apiKey?: string; workspaceFolder: string }
export interface LaunchSpec { command: string; args: string[]; env: Record<string, string>; shell?: boolean }
export type AuthMethodSpec =
  | { kind: 'oauth-browser'; label: string; terminalCommand?: string[] }
  | { kind: 'api-key'; label: string; envVar: string }
  | { kind: 'agent-managed'; label: string };
export interface UsageWindow { label: string; usedPercent: number; resetsAt?: number }
export interface UsageReading { windows: UsageWindow[]; note?: string }
export interface UsageSource { read(ctx: LaunchContext, signal: AbortSignal): Promise<UsageReading> }
export interface SettingSpec { key: string; type: 'string' | 'number' | 'boolean' | 'enum'; label: string; default: unknown; options?: string[] }
export interface AgentAdapter {
  id: string; displayName: string; vendor: string;
  install: InstallSpec;
  launch(ctx: LaunchContext): LaunchSpec;
  auth: AuthMethodSpec[];
  settings: SettingSpec[];
  listModels?(session: AgentSessionInfo): ModelChoice[];
  usage?: UsageSource;
  rebuildExpiredSessions?: boolean;
  disableBuiltInTools?: boolean;
  mapError?(error: unknown): Error | undefined;
  mergeConfig?(settings: AgentSettings, env: Record<string, string>): Record<string, string>;
  systemPromptNote?: string;
}
```
- `agents.ts` exports `ADAPTERS: AgentAdapter[]` and `findAdapter(id: string): AgentAdapter | undefined`.

- [ ] **Step 1: Failing test** `noAgentBranching.test.ts`: reads every `.ts` under `src/core` and `src/sidebar`, asserts none matches `/['"`](claude|codex|google)['"`]/` or `/=== ?['"]acphub-/`. Expected failure first: file `adapter.ts` missing.
- [ ] **Step 2:** Write `adapter.ts` with the types above (add `Log`, `AgentSettings = Record<string, string | number | boolean>`, `AgentSessionInfo`, `ModelChoice` minimal definitions; refine in Task 10).
- [ ] **Step 3:** Write `agents.ts` returning an empty list for now; test `findAdapter('x')` is `undefined`.
- [ ] **Step 4:** Run `npx vitest run test/unit/noAgentBranching.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add AgentAdapter interface`.

---

### Task 3: Mock ACP agent

**Files:**
- Create: `test/fixtures/mock-acp-agent.cjs`, `test/unit/mockAgent.test.ts`
- Port from: `CODEX/test/unit/fake-adapter.cjs` (largest, most complete), `CODEX/test/unit/fake-app-server.cjs`, `GOOGLE/test/unit/fake-agent.cjs`

**Interfaces:**
- Produces: a node script speaking ACP JSON-RPC over stdio. Behavior selected by env `MOCK_ACP_MODE`: `normal` (initialize, session/new, session/prompt streams "hello" then ends turn, reports models and an `effort` config option), `auth-required` (returns error code -32000), `crash-mid-request` (exits during prompt), `garbage` (writes non-JSON line then valid replies), `slow` (waits for cancel), `usage` (replies to `account/rateLimits/read`-style call with fixed numbers).

- [ ] **Step 1: Failing test** `mockAgent.test.ts`: spawn with `process.execPath`, send `initialize` then `session/new` then `session/prompt`; assert response ids match and a `session/update` text chunk "hello" arrives (normal). One test per mode asserting its defining behavior.
- [ ] **Step 2:** Run it; expected FAIL (file missing).
- [ ] **Step 3:** Port the fake adapter, strip Codex-specific parts into the `usage` mode, add the five modes.
- [ ] **Step 4:** Run; expected PASS. **Step 5: Commit** `test: add mock ACP agent`.

---

### Task 4: Foundation ports (logging, rpc, processes, npm)

**Files:** Create `src/core/{logging,rpc,processes,hideConsole,npm}.ts`; tests `test/unit/{rpc,processes}.test.ts`
- Port from: `CLAUDE/src/logging.ts` (identical in CODEX; GOOGLE's `logging.ts` is larger, diff it and keep any extra it adds), `CLAUDE/src/rpc.ts` (+`CLAUDE/test/unit/rpc.test.ts`), `CLAUDE/src/processes.ts` (GOOGLE's `processes.ts` is 1.6 KB larger: reconcile, keep the superset) (+`CLAUDE/test/unit/processes.test.ts`), `CODEX/src/hideConsole.ts`, `CLAUDE/src/npm.ts`.

**Interfaces:** Produces `JsonRpcConnection`, `RpcError`, `isAuthRequiredError`, `killTree(pid)`, `recordAgent/killStrayAgents`, `runNpm(args, options)`, `findNpmCli()`. Names unchanged from sources.

- [ ] **Step 1:** Copy the tests first; run `npx vitest run test/unit/rpc.test.ts test/unit/processes.test.ts`. Expected FAIL (modules missing).
- [ ] **Step 2:** Port the sources; fix imports only.
- [ ] **Step 3:** Run tests; expected PASS. **Step 4: Commit** `feat: port rpc, processes, npm, logging`.

---

### Task 5: Settings and secrets

**Files:** Create `src/core/settings.ts`, `src/core/secrets.ts`, `test/unit/{settings,secrets}.test.ts`; Modify `package.json` (shared `acpHub.*` keys).
- Port from: `CLAUDE/src/auth.ts` `ApiKeyStore` (lines 142+), `CLAUDE/test/unit/secrets.ts`, `CLAUDE/test/unit/vscode-mock.ts` (copy to `test/unit/vscode-mock.ts`).

**Interfaces:**
- `readAgentSettings(adapter: AgentAdapter, config: WorkspaceConfigurationLike): AgentSettings` — merges adapter `SettingSpec` defaults with `acpHub.agents.<id>.<key>`; invalid types fall back to default and are listed in a returned `warnings: string[]` (return type `{ values: AgentSettings; warnings: string[] }`).
- `class AgentSecretStore { constructor(secrets: vscode.SecretStorage); get(agentId): Promise<string|undefined>; set(agentId, value): Promise<void>; delete(agentId): Promise<void> }` keyed `acpHub.apiKey.<agentId>`.
- Shared settings: `acpHub.sessions.idleTimeoutSeconds` (120), `acpHub.agent.idleShutdownMinutes` (30), `acpHub.debug.requestDump` (copy semantics from `CLAUDE/src/requestDump.ts`).

- [ ] **Step 1: Failing tests:** defaults returned when unset; `permissionMode` set to a number yields default plus one warning; secret round-trip and delete; secrets of two agents don't collide.
- [ ] **Step 2-4:** Implement, run `npx vitest run test/unit/settings.test.ts test/unit/secrets.test.ts`, expect PASS. **Step 5: Commit.**

---

### Task 6: Pure-logic ports (sessionStore, cache, identityPatterns, customizations, convert, requestDump)

**Files:** Create `src/core/{sessionStore,cache,identityPatterns,customizations,convert,requestDump}.ts` and matching tests.
- Port from: `CLAUDE/src/sessionStore.ts` (+test; GOOGLE's is 0.9 KB smaller, reconcile), `CLAUDE/src/cache.ts` (CODEX's is 2.8 KB smaller; keep Claude's superset only if the extra is generic, otherwise make it an optional method), `CLAUDE/src/identityPatterns.ts`, `CLAUDE/src/customizations.ts` (+test), `CLAUDE/src/convert.ts` (+`convert.test.ts`; GOOGLE's is 1.5 KB smaller: diff and keep the superset), `CLAUDE/src/requestDump.ts` (CODEX's differs slightly: diff). Test helpers: `CLAUDE/test/unit/messages.ts`.

**Interfaces:** Names unchanged (`SavedSessionStore`, `CacheTracker`, `toAcpPrompt`-style exports as in sources). `cache.ts` must take no agent name; display strings come from the caller.

- [ ] **Step 1:** Copy tests; run; expected FAIL. **Step 2:** Port. **Step 3:** Run `npx vitest run test/unit`; expected PASS. **Step 4: Commit** per two modules, not one giant commit.

---

### Task 7: AgentClient (ACP client and supervision)

**Files:** Create `src/core/agentClient.ts`, `test/unit/agentClient.test.ts`
- Port from: `CLAUDE/src/agent.ts` (43 KB), `CODEX/src/agent.ts` (47 KB), `GOOGLE/src/agent.ts`; tests `CODEX/test/unit/agent.test.ts` (most complete), `CLAUDE/test/unit/agent.test.ts`, `GOOGLE/test/unit/agent.test.ts`.

**Interfaces:**
- Consumes: `AgentAdapter.launch`, `LaunchContext`, `JsonRpcConnection`.
- Produces: `class AgentClient { constructor(adapter, ctx: LaunchContext, deps) ; ensureStarted(): Promise<void>; createSession(opts); prompt(...); cancel(...); dispose() }`, plus `AdapterNotInstalledError` (message must say "install from the ACP Hub sidebar"). Hook points replacing agent-specific code: `adapter.mergeConfig`, `adapter.mapError`, `adapter.disableBuiltInTools`, `adapter.rebuildExpiredSessions`.

- [ ] **Step 1:** Diff the three `agent.ts`; list differences in the task commit message as one of: hook (goes to adapter), bug (fix to superset), or incidental.
- [ ] **Step 2: Failing tests** using the mock agent (command `process.execPath`, args `[mock path]`, env `MOCK_ACP_MODE`): normal prompt streams "hello"; `auth-required` surfaces `isAuthRequiredError`; `crash-mid-request` rejects the request, and a following `prompt` restarts and succeeds; `garbage` line is logged and ignored; idle shutdown after `idleShutdownMinutes` using fake timers; not installed -> `AdapterNotInstalledError`.
- [ ] **Step 3:** Port, replacing each agent-specific branch with a hook call. **Step 4:** Run `npx vitest run test/unit/agentClient.test.ts`; expected PASS. **Step 5: Commit.**

---

### Task 8: Installers

**Files:** Create `src/core/installers.ts`, `test/unit/installers.test.ts`
- Port from: `CLAUDE/src/adapter.ts` (`AdapterInstaller`, `findAdapterEntry`) and its test `CLAUDE/test/unit/adapter.test.ts`; `CODEX/src/adapter.ts` (diff); `GOOGLE/src/server.ts` (download of `agy_acp_server` from dl.google.com) with `GOOGLE/test/unit/server.test.ts`; `GOOGLE/src/launch.ts` + `launch.test.ts` for spawn rules.

**Interfaces:**
- `installAgent(adapter: AgentAdapter, ctx: InstallContext): Promise<InstallResult>` where `InstallResult = { installDir: string; version: string }`.
- `getInstallState(adapter, storageDir): Promise<'installed' | 'not-installed' | 'update-available'>`.
- Handles `InstallSpec` kinds `npm`, `download`, `existing-cli`. Download verifies platform/arch; unsupported platform returns a readable error.
- Windows launch: build `command`/`args` without `shell: true` by resolving `.cmd` shims to their node entry; quote nothing by hand. Test with a workspace path containing a space and a non-ASCII character.

- [ ] **Step 1: Failing tests** with a fake npm (inject `runNpm`) and fake downloader: install writes a marker with version; reinstall of same version is a no-op; failure leaves state `not-installed`; path with space and `é`.
- [ ] **Step 2-4:** Implement, run, expect PASS. **Step 5: Commit.**

---

### Task 9: McpBridge, systemPrompt, requestContext

**Files:** Create `src/core/{bridge,systemPrompt,requestContext}.ts` and tests.
- Port from: `CLAUDE/src/bridge.ts` (+`bridge.test.ts`; GOOGLE's differs by ~0.3 KB: diff), `CLAUDE/src/systemPrompt.ts` (+test; GOOGLE's is 2 KB larger: diff, move agent-specific text to `adapter.systemPromptNote`), `CLAUDE/src/requestContext.ts` (+test; identical in CODEX; **GOOGLE's has diverged**: diff, decide per hunk, write the decision list in the commit message, and make the shared test pass for the superset behavior; anything Google-only becomes an adapter hook).

**Interfaces:** `buildSystemPromptAppend(input, adapter.systemPromptNote)`, rest unchanged.

- [ ] **Step 1:** Copy tests (use Google's `requestContext.test.ts` cases too, merged); expected FAIL. **Step 2:** Port. **Step 3:** Run; PASS. **Step 4: Commit.**

---

### Task 10: Models

**Files:** Create `src/core/models.ts`, `src/adapters/codexModelCatalog.ts` (later used by Codex adapter), tests.
- Port from: `CLAUDE/src/models.ts` (+`models.test.ts`), `CODEX/src/models.ts` (+test), `CODEX/src/modelCatalog.ts` (+`modelCatalog.test.ts`), `GOOGLE/src/models.ts` (+test).

**Interfaces:** `toModelInformation(choice, id, effortLevels, vendor)`; core default reads ACP `configOptions` (model, effort) as in the sources; `adapter.listModels` overrides. Context-window and max-output defaults become fields of `ModelChoice` supplied by the adapter, not constants in core.

- [ ] **Step 1-4:** tests first, port, run `npx vitest run test/unit/models.test.ts`, PASS. **Step 5: Commit.**

---

### Task 11: Provider

**Files:** Create `src/core/provider.ts`; tests `test/unit/provider*.test.ts`.
- Port from: `CODEX/src/provider.ts` (66 KB, most complete), diff against `CLAUDE/src/provider.ts` and `GOOGLE/src/provider.ts`. Tests: `CODEX/test/unit/provider.test.ts`, `providerHeldCalls`, `providerIdle`, `providerStability`, `providerTurns`; `GOOGLE/test/unit/providerCache.test.ts`.

**Interfaces:**
- `class AcpProvider implements vscode.LanguageModelChatProvider { constructor(adapter: AgentAdapter, deps: ProviderDeps) }`; one instance per adapter; per-adapter sessions and process (no shared mutable singletons).
- Provider is split while porting: if the result exceeds ~800 lines, move held tool calls, idle handling and turn assembly into `src/core/provider/*.ts` files with one responsibility each.

- [ ] **Step 1:** Copy tests, adapt constructor to take a test adapter pointing at the mock agent; expected FAIL.
- [ ] **Step 2:** Port. Replace agent-specific code with adapter hooks (cache display, status bar removed).
- [ ] **Step 3: New tests (Review Focus 1 and 2):** not installed -> response error mentions the sidebar; two providers on two adapters run concurrently, each with its own process and session store, and idle shutdown of one does not stop the other.
- [ ] **Step 4:** Run `npx vitest run test/unit/provider`; PASS. **Step 5: Commit** in two or three commits.

---

### Task 12: Auth flow

**Files:** Create `src/core/auth.ts`, `test/unit/auth.test.ts`
- Port from: `CLAUDE/src/auth.ts` (+`auth.test.ts`), `CODEX/src/auth.ts` (+test), `GOOGLE/src/auth.ts` (+test), `CODEX/src/codexHome.ts` (+test) goes to the Codex adapter in Task 15.

**Interfaces:** `signIn(adapter, method: AuthMethodSpec, deps): Promise<SignInResult>` (`{ ok: true } | { ok: false; message: string }`). `api-key` stores via `AgentSecretStore` after `validateApiKey`; `oauth-browser` runs the agent's ACP `authenticate` (as in `CLAUDE/src/auth.ts` `terminalMethodsFrom`); `agent-managed` only reports status via `describeAuthStatus`. No `vscode.window.showQuickPick` inside core: the sidebar supplies the choice.

- [ ] **Step 1-4:** tests first (mock `auth-required` mode then success after authenticate), port, PASS. **Step 5: Commit.**

---

### Task 13: Usage store

**Files:** Create `src/core/usage.ts`, `test/unit/usage.test.ts`
- Port polling/caching ideas from: `CLAUDE/src/usage.ts` (`UsageMonitor`, `parseUsageMarkdown`; read it fully first, since recon did not cover the fetch path) and `CODEX/src/rateLimits.ts` (`readRateLimits`); tests `CLAUDE/test/unit/usage.test.ts`, `usageCache.test.ts`, `CODEX/test/unit/usage.test.ts`, `usageCache.test.ts`, `rateLimits.test.ts`.

**Interfaces:**
- `class UsageStore { constructor(fetchNow: () => number); refresh(adapter, ctx): Promise<void>; get(agentId): UsageState; onDidChange: Event<string> }`, where `UsageState = { status: 'unsupported' | 'loading' | 'ok' | 'error'; reading?: UsageReading; error?: string; fetchedAt?: number }`.
- Adapters without `usage` report `unsupported`. Cache ratio from `CacheTracker` is exposed as an extra window by the provider via `UsageStore.addExtra(agentId, window)`.

- [ ] **Step 1: Failing tests** with a fake `UsageSource`: ok, error keeps last good reading, `unsupported`, refresh throttling (no second fetch within 60 s, fake timers).
- [ ] **Step 2-4:** Implement, PASS. **Step 5: Commit.**

---

### Task 14: Google adapter

**Files:** Create `src/adapters/google.ts`, `test/unit/adapters/google.test.ts`; Modify `src/core/agents.ts`.
- Source: `GOOGLE/src/launch.ts`, `GOOGLE/src/server.ts`, `GOOGLE/src/quota.ts` (`QuotaLimitError`; becomes `mapError`), `GOOGLE/src/auth.ts`, settings from `GOOGLE/package.json` (command/args override).

**Interfaces:** `export const googleAdapter: AgentAdapter` with `install: { kind: 'download', ... }`, env `GEMINI_API_KEY`, `GOOGLE_ACP_LOGS`, `disableBuiltInTools: true`, `rebuildExpiredSessions: true`, `mapError` for quota errors, no `usage`.

- [ ] **Step 1: Failing tests:** `launch()` returns no shell on Windows for a path with spaces and `é` (Review Focus 4); command/args overrides honored; override with shell metacharacters (`& calc`) is passed as a literal arg, never interpreted; quota error mapped.
- [ ] **Step 2-4:** Implement, add to `ADAPTERS`, PASS. **Step 5: Commit.**

---

### Task 15: Claude and Codex adapters

**Files:** Create `src/adapters/{claude,codex}.ts`, `src/adapters/codexHome.ts`, tests `test/unit/adapters/{claude,codex}.test.ts`; Modify `src/core/agents.ts`.
- Claude source: `CLAUDE/src/adapter.ts` constants (`@agentclientprotocol/claude-agent-acp`, version `0.94.0`), `CLAUDE/src/usage.ts` (5h + weekly source), `CLAUDE/package.json` settings.
- Codex source: `CODEX/src/adapter.ts` constants, `CODEX/src/codexHome.ts`, `CODEX/src/rateLimits.ts`, `CODEX/src/modelCatalog.ts`, `CODEX/package.json` settings (`maxContextWindow`).

**Interfaces:** `claudeAdapter`, `codexAdapter` (`AgentAdapter`). Claude env `ANTHROPIC_API_KEY`; Codex env `CODEX_API_KEY`, `CODEX_HOME`, `CODEX_CONFIG` via `mergeConfig` (MCP timeout merged; invalid user JSON returns a readable error and `readAgentSettings`-style warning, Review Focus 3). Codex usage via `codex app-server` `account/rateLimits/read` using the mock agent's `usage` mode in tests.

- [ ] **Step 1: Failing tests:** each adapter's `launch()` output (command/args/env); Codex invalid config JSON -> error naming the setting; Codex usage reading mapped to `UsageWindow[]`; Claude usage parse of a fixture markdown copied from `CLAUDE/test/unit/usage.test.ts`.
- [ ] **Step 2-4:** Implement, PASS. **Step 5: Commit** per adapter.

---

### Task 16: Registry manifest, generator, generic adapter, fixture agent

**Files:** Create `registry/agents.json`, `scripts/generate-vendors.mjs`, `src/adapters/generic.ts`, `src/core/manifest.ts`, `test/fixtures/fixture-agent.json`, `test/unit/{generator,generic}.test.ts`; Modify `package.json` (`generate`, `generate:check` scripts), `.github/workflows/ci.yml` (runs `generate:check`).
- Source of agent data: https://agentclientprotocol.com/get-started/agents (read once to shape the schema; the generator reads only the local `registry/agents.json`, never the network).

**Interfaces:**
- Manifest entry: `{ id, displayName, install: { kind: 'npm', package, version, entry? } | { kind: 'existing-cli', command }, launch: { args: string[]; env?: Record<string,string> }, auth: AuthMethodSpec[] }`. `manifestToAdapter(entry: ManifestEntry): AgentAdapter` in `generic.ts`.
- `generate-vendors.mjs`: for each entry writes `contributes.languageModelChatProviders[]` (`vendor: "acphub-<id>"`, `displayName`), matching `activationEvents`, and `acpHub.agents.<id>.enabled` setting. `--check` exits non-zero if `package.json` differs from generated output.
- `registry/agents.json` lists claude, codex, google (id + displayName only needed for vendors; their behavior stays in hand-written adapters). A unit test asserts each manifest id has an `ADAPTERS` entry, or a manifest launch spec.

- [ ] **Step 1: Failing tests:** generator output for a two-entry fixture equals expected JSON; `--check` fails on a hand-edited vendor; `manifestToAdapter(fixture)` launches `process.execPath` + mock agent and a prompt through `AgentClient` streams "hello" (proves Level 1 with no adapter code).
- [ ] **Step 2-4:** Implement, run `npm run generate:check` and tests, PASS. **Step 5: Commit.**

---

### Task 17: Sidebar host and message protocol

**Files:** Create `src/sidebar/{host,messages}.ts`, `test/unit/sidebarHost.test.ts`; Modify `package.json` (view container `acpHub` in activitybar, view `acpHub.agents`).

**Interfaces:** `messages.ts` (plain discriminated unions):
- To webview: `{ type: 'state'; agents: AgentCardState[] }`; `AgentCardState = { id; displayName; install: 'installed'|'not-installed'|'update-available'|'installing'; signedIn: 'yes'|'no'|'unknown'; enabled: boolean; settings: SettingView[]; usage: UsageState; busy?: string; error?: string }`.
- From webview: `{ type: 'install'|'signIn'|'signOut'|'setEnabled'|'refreshUsage'; agentId; ... }`, `{ type: 'setSetting'; agentId; key; value }`, `{ type: 'ready' }`.
- `class SidebarHost implements vscode.WebviewViewProvider { constructor(deps: SidebarDeps) }`; `handleMessage(msg)` is a plain method so tests call it without a webview.

- [ ] **Step 1: Failing tests:** `ready` posts `state` for every adapter; `install` calls `installAgent` once and posts `busy`/`installed` updates; install failure posts `error`; `setSetting` writes `acpHub.agents.<id>.<key>`; unknown agentId is ignored.
- [ ] **Step 2-4:** Implement, PASS. **Step 5: Commit.**

---

### Task 18: Sidebar UI

**Files:** Create `media/sidebar.html`, `media/sidebar.css`, `src/sidebar/webview/main.ts` (bundled by esbuild to `dist/sidebar.js`); Modify `esbuild.js`.
- Plain HTML/TS, no framework. Use VS Code CSS variables. CSP with nonce, no inline script.

**Interfaces:** Renders one card per agent from the `state` message: title, install button (label from state), sign-in/sign-out, enable toggle, settings (inputs generated from `SettingView`), usage bars (`UsageWindow.usedPercent`, reset text), error line. An "Add agent" section lists manifest entries not yet bundled (read-only list in v1, shown disabled with the text "Included in a future release").

- [ ] **Step 1:** Write `render(state)` as a pure function `renderCards(agents: AgentCardState[]): string` (HTML escaped) with a vitest test: contains the install button for `not-installed`, usage bar widths 40%, escaped `<script>` in an error string.
- [ ] **Step 2-3:** Implement, run test; PASS.
- [ ] **Step 4 (manual):** F5, open ACP Hub view; confirm cards render in light and dark themes. **Step 5: Commit.**

---

### Task 19: Extension wiring

**Files:** Modify `src/extension.ts`, `package.json` (commands, activation events, view, `acpHub.*` config generated parts), `src/core/agents.ts`.

**Interfaces:** `activate(context)` loops `ADAPTERS`; for each registers `vscode.lm.registerLanguageModelChatProvider(adapter.vendor, new AcpProvider(adapter, deps))`, builds the `UsageStore`, `SidebarHost`, `AgentSecretStore`, and registers dispose of all agent processes on deactivate (`killAllChildren`, `killStrayAgents` as in `CLAUDE/src/extension.ts`). Commands: `acpHub.showLogs`, `acpHub.refreshUsage`, `acpHub.signIn` (pick agent), `acpHub.install`. No status bar items. Replaces the spike stub provider. Source: `CLAUDE/src/extension.ts`, `GOOGLE/src/extension.ts` (7 KB).

- [ ] **Step 1: Failing test** (`test/unit/extension.test.ts` with the vscode mock): `activate` registers one provider per `ADAPTERS` entry with vendors equal to those in `package.json` `contributes.languageModelChatProviders` (catches generator drift).
- [ ] **Step 2-4:** Implement; `npm run typecheck && npm test`; PASS. **Step 5: Commit.**

---

### Task 20: Smoke test, CI, packaging, README

**Files:** Create `test/smoke/extension.test.ts`, `.vscode-test.mjs`, `.github/workflows/ci.yml`, `README.md`; Modify `package.json` (`package` script via `@vscode/vsce`).
- Port from: `CLAUDE/test/smoke/extension.test.ts`, `CODEX/test/smoke/extension.test.ts`, `CLAUDE/.vscode-test.*`, any existing workflow in the sources.

**Interfaces:** CI (windows-latest): `npm ci`, `generate:check`, `typecheck`, `lint`, `test`, `npm run package` uploads the VSIX as an artifact.

- [ ] **Step 1:** Smoke test asserts the extension activates and `vscode.lm.selectChatModels({ vendor: 'acphub-claude' })` call doesn't throw (models may be empty).
- [ ] **Step 2:** Run `npm run test:smoke`; PASS. Run `npm run package`; a `.vsix` is produced.
- [ ] **Step 3:** README: what it is, side-by-side install with old extensions, how to add an agent (manifest entry, `npm run generate`), how to write a Level 2 adapter.
- [ ] **Step 4:** Push branch and confirm CI is green. **Step 5: Commit.**

---

### Task 21: Parity checklist (author runs manually)

**Files:** Create `docs/parity-checklist.md`.

Contents, to be copied verbatim into the file as checkboxes. Run for each of Claude, Codex, Google, comparing against the old extension on the same machine (both installed; new vendors are separate):
- [ ] Sidebar: install the agent from the card; progress shown; card flips to installed.
- [ ] Sign in with each supported method (Claude: auto/API key/OAuth; Codex: API key and ChatGPT login; Google: API key). Sign out works.
- [ ] Agent appears in the Copilot model picker under its own group; model list and effort variants match the old extension.
- [ ] Plain chat reply streams; multi-turn keeps context; cancel stops the turn.
- [ ] Tool use: Copilot tool call round trip (read file, edit file, terminal) works as in the old extension.
- [ ] Long chat: session reuse and fork on edited history behave as before; Google: expired session rebuilds from transcript.
- [ ] Idle: process exits after the idle timeout; next message restarts it.
- [ ] Usage: Claude 5h + weekly + cache ratio; Codex rate limits; Google shows "not supported".
- [ ] Settings changes in the sidebar take effect (permissionMode, authPreference, timeouts, Codex maxContextWindow, Google command/args).
- [ ] Failure modes: wrong API key, offline install, kill the agent process mid-reply: readable error, next message works.
- [ ] Windows path with spaces/non-ASCII as workspace folder.
- [ ] Old and new extensions installed together: no setting or vendor collisions.
- [ ] Reload window: no orphan agent processes left (Task Manager).

- [ ] **Step 1:** Create the file. **Step 2: Commit** `docs: add parity checklist`.

---

## Self-review notes

- Spec coverage: adapter pattern (T2, lint test), static vendors + generator (T1, T16), sidebar (T17-18), usage in sidebar only (T13, T19), three agents (T14-15), Level 1 fixture (T16), side-by-side IDs (T5, T16), mock-agent tests (T3), parity checklist (T21), CI/VSIX (T20), spike gate (T1).
- Known gaps for the author: the exact `UsageSource` for Claude depends on reading `CLAUDE/src/usage.ts` in Task 13/15 (not yet read in detail); Google's quota path is only partly read. Both are handled by "read fully first" steps.
