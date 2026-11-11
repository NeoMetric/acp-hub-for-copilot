# Dashboard Server Header, Server Settings and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the server address, token link and alive indicator at the top of the dashboard, add a Server settings view (port) and a collapsible Docs view.

**Architecture:** The control page (`ControlPage`) runs inside the server, so the server describes itself in `ControlState.server`, supplied by a new `ServerSurface` that `src/main/server.ts` implements over `config.json`. The port lives in `config.json` (`server.port`), is read at server start and by `ServerLink` to find the server, and a restart action stops the server so the window's relay starts it again on the new port. The sidebar relay marks the state not alive when the link drops. Server settings and Docs are new `PageView`s drawn by `src/ui/render.ts`.

**Tech Stack:** TypeScript, esbuild, vitest (`npm test`), eslint (`npm run lint`), `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-11-11-dashboard-server-docs-design.md`

## Global Constraints

- The port is a server setting stored in `<root>/config.json` as `acpHub.server.port` (section `server.port` through `FileConfig`). There is no VS Code `acpHub.server.port` setting.
- Port precedence on the server: `ACP_HUB_PORT` env, then `server.port` in `config.json`, then `8791`. Valid ports are integers 1–65535 in the UI; an invalid stored value reads as the default.
- The port applies on the next server start. The Restart button carries a note that restarting ends any existing sessions.
- The header link is `http://127.0.0.1:<port>/?token=<token>`, opens in the browser, with a green indicator when alive and a red one when not.
- Docs sections are all collapsible `<details>`; Docs sits right after Usage in the nav; Server settings after Docs.
- Match the existing UI: tab buttons in `renderNav`, `.global-settings`-style blocks, styles in `media/sidebar.css`, tabs and escaping via `escapeHtml`.
- Source files carry the NeoMetric MIT header; comments only where needed.

## Review Focus

- Saved port differs from the running port: Server settings shows both and says it applies after restart (Task 4 test).
- Port typed as `0`, `70000`, `80.5`, empty or non-numeric: rejected, nothing written (Task 2 test, Task 4 test).
- Server unreachable: header turns red and never shows the stale green state (Task 3 test).
- `ACP_HUB_PORT` set on a hand-started server: the saved port is ignored, so the field is disabled with a note (Task 2 and 4 tests).
- Changing the port leaves `providers.json` pointing at the old address: the Server settings note and the Docs tell the user to run **ACP Hub: Sync Models** and restart the Copilot CLI (Task 4 and 5 tests).

---

### Task 1: Port in config, server start and ServerLink

**Files:**
- Modify: `src/hosts/http/config.ts` (add the port helpers)
- Modify: `src/main/server.ts` (`portOf`, `startServer`)
- Modify: `src/hosts/vscode/serverLink.ts` (`port`, `baseUrl`, `spawnServer`)
- Test: `test/unit/server.test.ts` or a new `test/unit/serverPort.test.ts`; `test/unit/serverLink.test.ts`

**Interfaces:**
- Produces in `config.ts`:
  - `export const DEFAULT_PORT = 8791;`
  - `export const SERVER_PORT = 'server.port';`
  - `export function isPort(value: unknown): value is number`: integer 1–65535.
  - `export function serverPortOf(config: ConfigReader): number`: the stored port when `isPort`, else `DEFAULT_PORT`.
- `ServerLink` keeps `deps.port` (tests) as the first choice, then `serverPortOf(loadConfig(deps.root))`, then `DEFAULT_PORT`. `port` and `baseUrl` become getters that re-read the file, so a port saved while the window runs is found.
- `spawnServer` sets `ACP_HUB_PORT` only when `deps.port` is given, and deletes an inherited `ACP_HUB_PORT` otherwise, so the server reads the port from `config.json` itself.
- `startServer` resolves the port as env → `serverPortOf(loadConfig(root, stderrLog))`. The existing "must be a port number" error for a bad env value stays.

- [ ] **Step 1: Write failing tests**
  - `serverPortOf` returns `8791` for an empty config, for `0`, `70000`, `80.5` and `"80"`, and `9000` when `server.port` is `9000` (use a `ConfigReader` stub with `get`).
  - `serverLink.test.ts`: with `config.json` holding `{"acpHub":{"server":{"port":9100}}}` in the test root and no `deps.port`, a failing probe followed by `ensure()` spawns with an env whose `ACP_HUB_PORT` is undefined and probes `http://127.0.0.1:9100/health`; after rewriting the file to port 9200, the next probe goes to 9200.
- [ ] **Step 2: Run to verify they fail:** `npx vitest run test/unit/serverLink.test.ts test/unit/serverPort.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, and make `ServerLink.port`/`baseUrl` getters over them (replace the `private readonly port`/`baseUrl` fields and the `SERVER_PORT` constant; message strings keep using `this.port`). Remove `DEFAULT_PORT` from `src/main/server.ts` in favour of the shared one.
- [ ] **Step 4: Run to verify they pass:** same command, plus `npx vitest run test/unit/server.test.ts test/unit/extension.test.ts` — Expected: PASS (existing port tests keep passing).
- [ ] **Step 5: Commit** `feat: read the server port from config.json`.

### Task 2: Server surface in the state and actions

**Files:**
- Modify: `src/ui/messages.ts` (`ServerView`, `ServerSurface`, `ControlState.server`, two actions)
- Modify: `src/ui/controlPage.ts` (constructor takes `server?: ServerSurface`; `state()` and `handle()`)
- Modify: `src/hosts/http/server.ts` (`ControlPageOptions.server`, passed through `openPage`)
- Modify: `src/main/server.ts` (implements the surface)
- Test: `test/unit/controlPage.test.ts`, `test/unit/server.test.ts`

**Interfaces:**
- Produces in `messages.ts`:
  ```ts
  export interface ServerView {
  	/** The port the server is listening on now. */
  	port: number;
  	/** The port saved for the next start; differs from `port` until a restart. */
  	savedPort: number;
  	/** The control page's address with the token, for the header link. */
  	url: string;
  	/** `ACP_HUB_PORT` names the port, so the saved one is ignored. */
  	portFromEnv: boolean;
  	/** The server answered; the sidebar relay sets this to false when its link drops. */
  	alive: boolean;
  }
  export interface ServerSurface {
  	view(): ServerView;
  	setPort(port: number): Promise<void>;
  	restart(): void;
  }
  ```
  `ControlState.server?: ServerView`; `FromWebview` gains `{ type: 'setServerPort'; port: number } | { type: 'restartServer' }`.
- `ControlPage.handle`: `setServerPort` calls `server.setPort` only when `isPort(action.port)` (import from `hosts/http/config` is not allowed in `src/ui`; duplicate a 1-line integer-range check in `controlPage.ts` instead) and `!view().portFromEnv`, then `publish()`; `restartServer` calls `server.restart()`. Without a surface both are ignored.
- `main/server.ts`: `view()` returns `{ port: boundPort, savedPort: serverPortOf(config), url: \`http://127.0.0.1:${boundPort}/?token=${encodeURIComponent(token)}\`, portFromEnv: Boolean(env.ACP_HUB_PORT?.trim()), alive: true }`; `setPort` writes `config.set(SERVER_PORT, port)`; `restart` calls the existing `stop('SIGTERM')`. `boundPort` is set in the `listen` callback (it starts as the requested port). Pass it as `page: { control, server }`.

- [ ] **Step 1: Write failing tests** in `controlPage.test.ts`: `state()` carries `server` from a stub surface; `handle({type:'setServerPort', port: 9100})` calls `setPort(9100)` and publishes; ports `0`, `70000`, `80.5`, `NaN` call nothing; with `portFromEnv: true` nothing is written; `handle({type:'restartServer'})` calls `restart()`. In `server.test.ts`: `/api/state` includes `server.url` ending `/?token=<token>` when the page options carry a surface.
- [ ] **Step 2: Run to verify they fail:** `npx vitest run test/unit/controlPage.test.ts test/unit/server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run to verify they pass:** same command, then `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: describe the server in the control page state`.

### Task 3: Relay reports a dropped link as not alive

**Files:**
- Modify: `src/sidebar/relay.ts` (`withLinkError`)
- Modify: the relay's comment "The token never leaves this class" to say the state now carries the header link, which the server only gives to authenticated clients.
- Test: `test/unit/sidebarRelay.test.ts`

**Interfaces:**
- Consumes: `ControlState.server` from Task 2.
- `withLinkError` returns `{ ...latest, server: latest.server && { ...latest.server, alive: false }, agents }`.

- [ ] **Step 1: Write the failing test** next to the existing `unavailable` test (~line 309): after a state with `server.alive === true`, a link change to `unavailable` delivers a state whose `server.alive` is `false` and whose `server.port` is unchanged.
- [ ] **Step 2: Run:** `npx vitest run test/unit/sidebarRelay.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the change in `withLinkError`.
- [ ] **Step 4: Run:** same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat: mark the server not alive when the sidebar loses it`.

### Task 4: Header strip and Server settings view

**Files:**
- Modify: `src/ui/render.ts` (`PageView`, `PageViews`, `renderNav`, new `renderServerHeader`, `renderServerSettings`)
- Modify: `src/ui/page.ts` (state, view switching, click handling, drafts)
- Modify: `media/sidebar.css`
- Test: `test/unit/sidebarRender.test.ts`

**Interfaces:**
- Consumes: `ServerView` and the two actions from Task 2.
- Produces: `PageView = 'agents' | 'models' | 'usage' | 'docs' | 'server'`; `PageViews` gains `readonly server?: boolean`; `renderNav` draws, in order, Agents, Models, Usage, **Docs** (always), **Server settings** (when `available.server`), with actions `showDocs` and `showServer`.
- `export function renderServerHeader(server: ServerView): string`: `<div class="server-status">` with a `<span class="status-dot alive|down">`, and an `<a class="server-link" href="${url}" target="_blank" rel="noopener">127.0.0.1:${port}</a>` when alive; when not alive the dot is red and the text reads `Server not reachable (127.0.0.1:${port})` without a link. All values escaped.
- `export function renderServerSettings(server: ServerView, draftPort: string | undefined): string`: a `Port` number input (`data-server-port`, min 1, max 65535, value = draft ?? savedPort), a `Save` button (`data-action="saveServerPort"`), a `Restart server` button (`data-action="restartServer"`) with the note "Restarting stops the server and ends any existing sessions." When `savedPort !== port` a note reads `Running on ${port}; ${savedPort} is used after a restart.` When `portFromEnv`, the input and Save are `disabled` with the note "The port is set by ACP_HUB_PORT." A note says: "After a port change run ACP Hub: Sync Models and restart the Copilot CLI so its providers.json points at the new address."
- `page.ts`: `draw()` draws `renderServerHeader` above the nav when `server` exists, always draws the nav, and passes `{ models, usage, server: server !== undefined }`; `saveServerPort` reads the input, sends `{ type: 'setServerPort', port: Number(value) }` only when it is an integer 1–65535 and otherwise leaves the draft with an inline error line; `restartServer` sends `{ type: 'restartServer' }`.

- [ ] **Step 1: Write failing tests** in `sidebarRender.test.ts`: nav contains `data-action="showDocs"` always and `showServer` only with `server: true`, Docs after Usage; header with `alive: true` contains the link `href` with the token URL, `status-dot alive`, and `127.0.0.1:8791`; with `alive: false` contains `status-dot down`, no `href`; settings view with `savedPort: 9100`, `port: 8791` contains both numbers and the restart note and the Sync Models note; `portFromEnv: true` renders `disabled` and `ACP_HUB_PORT`; token and URL characters in the view are escaped.
- [ ] **Step 2: Run:** `npx vitest run test/unit/sidebarRender.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the renderers, `page.ts` wiring (keep the draft port in a `let draftPort` like `keyDrafts`, restored after `draw()`), and CSS: `.server-status` (flex, gap, bordered like `.global-settings`), `.status-dot` (8px circle; `.alive` uses `var(--vscode-testing-iconPassed, #3fb950)`, `.down` uses `var(--vscode-errorForeground)`), `.page-nav` gets `flex-wrap: wrap`.
- [ ] **Step 4: Run:** same command, then `npx vitest run` — Expected: PASS (fix any existing test that assumed no nav).
- [ ] **Step 5: Commit** `feat: add the server header and server settings to the dashboard`.

### Task 5: Docs view

**Files:**
- Create: `src/ui/docs.ts` (`renderDocsView`)
- Modify: `src/ui/page.ts` (draw `renderDocsView()` for `view === 'docs'`)
- Modify: `media/sidebar.css`, `README.md`, `CHANGELOG.md`
- Test: `test/unit/sidebarRender.test.ts`

**Interfaces:**
- Produces: `export function renderDocsView(): string` returning three `<details class="docs-section">` blocks, each with a `<summary>` and static, escaped copy:
  1. **Server**: one local process on 127.0.0.1 that serves this dashboard and the OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`) and runs the agents; every window and client shares it; every request needs the bearer token kept in `server.token`; it closes itself after the idle timeout. Settings, one line each: Port (Server settings; applies on restart; `ACP_HUB_PORT` overrides), `acpHub.server.idleTimeoutMinutes` (default 30, `0` never closes), `acpHub.server.detached` (default on), Restored chat detail / size limit / tool result limit (Settings block on the Agents tab).
  2. **VS Code Copilot client**: models appear in Copilot Chat's model picker; the settings are `acpHub.server.idleTimeoutMinutes` and `acpHub.server.detached` in VS Code Settings; **ACP Hub: Sync Models** pulls the models and your provider and model names into Copilot (reload the window after a renamed provider).
  3. **Copilot CLI**: run **ACP Hub: Sync Models**; it writes the models with the server's address and token to `~/.copilot/providers.json` (or `COPILOT_PROVIDERS_CONFIG`); restart the CLI; run it again after a port change or a renamed model.
- Sections are closed by default; their open state needs no persistence.

- [ ] **Step 1: Write failing tests**: `renderDocsView()` contains exactly three `<details` elements, none `open`, whose summaries are `Server`, `VS Code Copilot client`, `Copilot CLI`; the text contains `ACP Hub: Sync Models`, `providers.json`, `acpHub.server.idleTimeoutMinutes`, `acpHub.server.detached`; `renderNav('docs', …)` marks Docs pressed.
- [ ] **Step 2: Run:** `npx vitest run test/unit/sidebarRender.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `docs.ts` (style `.docs-section` like `.global-settings`), the `page.ts` branch, and add one README line under the control-page bullets plus a CHANGELOG entry for the header, Server settings and Docs.
- [ ] **Step 4: Run:** `npx vitest run && npm run typecheck && npm run lint` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat: add the Docs view to the dashboard`.
