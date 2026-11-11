# Models Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Models page where the user sets the provider name and each model name shown in VS Code's and the Copilot CLI's model pickers, with Save and Sync applying them to both.

**Architecture:** Name overrides live in the server's state store (`server.modelNames`). `ModelCatalog.wireOf` applies model-name overrides to `/v1/models` (VS Code reads `acp.name`). A `ModelsSurface` built in `createServer` backs new `ControlPage` state and actions; its apply step writes the CLI's `providers.json` and the `displayName` of the matching `languageModelChatProviders` entries in `package.json`. The page (`render.ts`, `page.ts`) gets a Models view.

**Tech Stack:** TypeScript, Node `http`, vitest (`npx vitest run <file>`), `npx tsc --noEmit -p .`.

**Spec:** `docs/superpowers/specs/2026-11-10-models-page-design.md`

## Global Constraints

- Only display names change: never agent ids, `vendor` ids (`vendorOf(agentId)` from `src/core/vendors.ts`), wire ids (`<agent>/<model>`), efforts or windows.
- A name is trimmed, 1 to 80 characters, no control characters; an empty string clears the override.
- Two models of one agent may not share a name; two agents may not share a provider name (compare case-insensitively); the save is refused with a message.
- Local only: the CLI `baseUrl` is `http://127.0.0.1:<bound port>/v1`.
- Entries in `providers.json` the page did not write are kept. Written entries are tracked in the store under `server.cliProviders` (names); the legacy provider `acp-hub` is replaced too.
- Agents that are disabled or not installed are left out of `providers.json`; an enabled agent whose lookup fails uses its saved list.
- The token never appears in a notice, a log line or a response.
- Notice after Save and after Sync: "Reload the VS Code window and restart the Copilot CLI for the changes to take effect." plus each failed target on its own line.
- Source files start with the repo's MIT header and use tabs.

## Review Focus

- A name with HTML (`<b>&"`) must be escaped on the page (Task 5).
- A duplicate model or provider name is refused and nothing is saved (Task 1).
- A missing or unwritable `package.json` is reported without stopping `providers.json` (Task 3, 4).
- A `providers.json` that is not valid JSON is not overwritten; Sync reports it (Task 3).
- Clearing a name restores the agent's own (Task 1, 2, 4).

## File Structure

- Create `src/engine/models/modelNames.ts`: override store and validation.
- Create `src/hosts/http/applyNames.ts`: the two file writers.
- Create `src/hosts/http/modelsSurface.ts`: `ModelsSurface` over the catalog, names and writers.
- Modify `src/hosts/http/server.ts`: export `ModelCatalog`, add `entriesOf`/`refresh`, apply overrides in `wireOf`, build the surface.
- Modify `src/ui/messages.ts`, `src/ui/controlPage.ts`, `src/ui/render.ts`, `src/ui/page.ts`.
- Delete `scripts/sync-copilot-models.ps1`; update `README.md`, `CHANGELOG.md`.
- Tests: `test/unit/modelNames.test.ts`, `applyNames.test.ts`, `modelsSurface.test.ts`, additions to `server.test.ts`, `controlTransport.test.ts`, and `modelsPage.test.ts`.

### Task 1: Override store

**Files:** Create `src/engine/models/modelNames.ts`; Test `test/unit/modelNames.test.ts`.

**Interfaces:**
- Produces:
  - `export const MODEL_NAMES_KEY = 'server.modelNames'`
  - `export interface NameOverrides { providers: Record<string, string>; models: Record<string, Record<string, string>> }`
  - `export class NameError extends Error {}`
  - `export class ModelNames { constructor(state: StateStore); overrides(): NameOverrides; providerName(agentId: string, fallback: string): string; modelName(agentId: string, value: string, fallback: string): string; setProvider(agentId: string, name: string, defaults: ReadonlyMap<string, string>): Promise<void>; setModel(agentId: string, value: string, name: string, models: ReadonlyArray<{ value: string; name: string }>): Promise<void> }`
  - `defaults` maps every agent id to its default provider name; `models` lists the agent's models with their default names. Both are what the uniqueness check compares against effective names.

- [ ] **Step 1: Write failing tests** in `modelNames.test.ts` over an in-memory `StateStore` (`get`, `update`, `keys`): stores and trims a provider name; `modelName` returns the fallback until set; an empty string clears; 81 characters and a name containing `\n` throw `NameError`; `setModel` refuses a name equal (case-insensitively) to another model's effective name in the same agent and leaves the store unchanged; `setProvider` refuses another agent's effective provider name; a stored value of the wrong shape (e.g. `42`) is read as no overrides.
- [ ] **Step 2: Run** `npx vitest run test/unit/modelNames.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** the class per the interface; one `state.update(MODEL_NAMES_KEY, next)` per successful change, none on refusal.
- [ ] **Step 4: Run** the same command; expect PASS.

### Task 2: Publish overridden model names

**Files:** Modify `src/hosts/http/server.ts` (`ModelCatalog`, `createServer`); Test `test/unit/server.test.ts`.

**Interfaces:**
- Consumes: `ModelNames` (Task 1).
- Produces: `export class ModelCatalog` with `constructor(composition: HeadlessComposition, names: ModelNames)`, `entriesOf(adapter: AgentAdapter): Promise<ModelEntry[]>` (saved list, else a lookup), and `refresh(adapter: AgentAdapter): Promise<ModelEntry[]>` (always a lookup, saving the result). `modelsOf` keeps its behavior.

- [ ] **Step 1: Write failing test** in `server.test.ts`: with `host.state.update('server.modelNames', { providers: {}, models: { mock: { 'mock-1': 'My Model' } } })` (use the mock adapter's id and a model value from the existing tests), `GET /v1/models` returns an entry whose `id` is unchanged and whose `acp.name` is `My Model`; without the override `acp.name` is the agent's own.
- [ ] **Step 2: Run** `npx vitest run test/unit/server.test.ts -t "model name"`; expect FAIL.
- [ ] **Step 3: Implement**: `wireOf` uses `names.modelName(agentId, entry.value, info.name)`; `createServer` builds `new ModelNames(composition.host.state)` and passes it to the catalog; add `entriesOf` and `refresh`.
- [ ] **Step 4: Run** `npx vitest run test/unit/server.test.ts`; expect all PASS.

### Task 3: File writers

**Files:** Create `src/hosts/http/applyNames.ts`; Test `test/unit/applyNames.test.ts`.

**Interfaces:**
- Produces:
  - `export interface CliProvider { name: string; models: ReadonlyArray<{ name: string; wireModel: string }> }`
  - `export function writeCliProviders(options: { file: string; baseUrl: string; token: string | undefined; providers: readonly CliProvider[]; previous: readonly string[] }): { written: string[] }` — removes providers named in `previous` or `acp-hub` and their models, keeps everything else, adds one `{ name, type: 'openai', baseUrl, bearerToken? }` per provider and one `{ id, provider, wireModel }` per model, where `id` is the model name with `/` and whitespace turned into `-`, made unique within the file by a numeric suffix; creates the folder when missing; throws `Error` naming the file when it exists but is not valid JSON, leaving it untouched. Returns the provider names written.
  - `export function writeVendorNames(options: { packageJson: string; names: Readonly<Record<string, string>> }): void` — sets `displayName` of each `contributes.languageModelChatProviders` entry whose `vendor` is a key of `names`, leaving others and the file's indentation and line endings as they were; throws when the file cannot be read or written.

- [ ] **Step 1: Write failing tests** using temp files: foreign provider and model survive; previous and `acp-hub` entries are replaced; ids are slash-free and unique for names `A/B` and `A B` colliding; `bearerToken` omitted when token is undefined; invalid JSON file → throws and the bytes are unchanged; `writeVendorNames` changes only the named vendor's `displayName` and keeps tab indentation; missing file throws.
- [ ] **Step 2: Run** `npx vitest run test/unit/applyNames.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** the same command; expect PASS.

### Task 4: Models surface

**Files:** Create `src/hosts/http/modelsSurface.ts`; Modify `src/hosts/http/server.ts` (`HttpServerOptions`, `ControlPageOptions`, `openPage`); Modify `src/ui/messages.ts`; Test `test/unit/modelsSurface.test.ts`.

**Interfaces:**
- Consumes: `ModelNames`, `ModelCatalog` source (Task 2), writers (Task 3), `vendorOf`.
- Produces in `src/ui/messages.ts`:
  - `export interface ModelsView { agents: Array<{ agentId: string; provider: { name: string; default: string }; models: Array<{ value: string; name: string; default: string }> }> }`
  - `ControlState` gains `models?: ModelsView; notice?: string`.
  - `FromWebview` gains `{ type: 'setProviderName'; agentId: string; name: string } | { type: 'setModelName'; agentId: string; model: string; name: string } | { type: 'syncModels' }`.
- Produces in `modelsSurface.ts`:
  - `export interface ModelsSurface { view(): Promise<ModelsView>; setProviderName(agentId: string, name: string): Promise<string>; setModelName(agentId: string, model: string, name: string): Promise<string>; sync(): Promise<string> }` (each action resolves to the notice text).
  - `export function createModelsSurface(deps: { composition: HeadlessComposition; names: ModelNames; source: { entriesOf(a: AgentAdapter): Promise<ModelEntry[]>; refresh(a: AgentAdapter): Promise<ModelEntry[]> }; token: string | undefined; baseUrl: () => string; providersFile: string; packageJson: string }): ModelsSurface`.
  - `HttpServerOptions` gains `providersFile?: string; packageJson?: string` (defaults: `COPILOT_PROVIDERS_CONFIG` or `~/.copilot/providers.json`; the `package.json` beside the bundle, found like `pageBundlePath`). `createServer` builds the surface and passes it as `ControlPageOptions.models?: ModelsSurface`.
- Behavior: `view()` lists every adapter's default provider name (`adapter.displayName`) and its saved models; `setProviderName`/`setModelName` validate through `ModelNames`, then run the apply step; `sync()` first calls `refresh` for each enabled, installed agent (falling back to `entriesOf` when it throws), then applies. Apply writes `providers.json` for enabled, installed agents with at least one model and records written provider names under `server.cliProviders`, then calls `writeVendorNames` with `{ [vendorOf(id)]: providerName }` for every adapter (default name when no override). Each target's failure becomes one notice line; the other target still runs. A `NameError` returns its message as the notice and writes nothing.

- [ ] **Step 1: Write failing tests** in `modelsSurface.test.ts` with fakes: a rename then apply writes `providers.json` with the new provider name, `wireModel` = `<agent>/<value>`, `baseUrl` ending `/v1`, and the token; a disabled agent is absent; `package.json` gets the vendor's new `displayName` and the cleared name restores the default; an unwritable `package.json` still leaves `providers.json` written and the notice mentions `package.json`; a duplicate name returns the refusal and the store is unchanged; the notice never contains the token; `sync` calls `refresh` and falls back when it throws.
- [ ] **Step 2: Run** `npx vitest run test/unit/modelsSurface.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the surface and the wiring above.
- [ ] **Step 4: Run** `npx vitest run test/unit/modelsSurface.test.ts test/unit/server.test.ts`; expect PASS.

### Task 5: Page state, actions and view

**Files:** Modify `src/ui/controlPage.ts`, `src/ui/render.ts`, `src/ui/page.ts`; Test `test/unit/controlTransport.test.ts` (route test), `test/unit/modelsPage.test.ts`.

**Interfaces:**
- Consumes: `ModelsSurface`, `ModelsView`, new actions (Task 4).
- Produces: `ControlPage` constructor takes `models?: ModelsSurface` as a third argument (`openPage` passes `options.models`); `state()` adds `models` and `notice`; `handle` runs the three new actions (a failure becomes the notice) and clears the previous notice first. `export function renderModels(models: ModelsView, notice?: string): string` in `render.ts`: one section per agent with a provider input (`data-models="provider"`, `data-agent`, placeholder = default) and a row per model (`data-models="model"`, `data-model`, placeholder = default), a Sync button (`data-action="syncModels"`), and the notice in a `role="status"` block; every interpolated value goes through `escapeHtml`. `mountPage` adds a header button `data-action="toggleModels"` switching between the cards and the Models view, sends `setProviderName`/`setModelName` on `change`, and `syncModels` on click.

- [ ] **Step 1: Write failing tests**: `modelsPage.test.ts` — `renderModels` escapes `<b>&"` in names and the notice, shows the default as placeholder, contains the Sync button; `mountPage` with the fake root from `controlTransport.test.ts` sends `syncModels` on click and `setModelName` on change. `controlTransport.test.ts` — over the real server with a fake `ModelsSurface`, `POST /api/action` `{type:'setModelName',...}` reaches the surface and `/api/state` includes `models` and the returned `notice`.
- [ ] **Step 2: Run** `npx vitest run test/unit/modelsPage.test.ts test/unit/controlTransport.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** per the interfaces; reuse the existing card/section CSS classes, adding only what the inputs need to `media/sidebar.css`.
- [ ] **Step 4: Run** the same command; expect PASS.

### Task 6: Retire the script, docs, full check

**Files:** Delete `scripts/sync-copilot-models.ps1`; Modify `README.md`, `CHANGELOG.md`.

- [ ] **Step 1:** Remove the script; in the README, describe the Models page (rename, Save/Sync, reload notice, the `npm run generate` caveat, the installed-extension caveat) where the manual server run is described; add a CHANGELOG entry.
- [ ] **Step 2: Run** `npx tsc --noEmit -p .` (expect no output), `npx vitest run` (expect all pass), and the repo's lint command from `package.json` (expect clean).
- [ ] **Step 3: Verify by hand** against a built server (`npm run compile`, `npm run server`, open the printed link): rename a provider and a model, Sync, then check `~/.copilot/providers.json` and `package.json`, and that the CLI picker shows the new names after a restart.
