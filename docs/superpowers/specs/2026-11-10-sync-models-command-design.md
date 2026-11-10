# Models page Refresh + `ACP Hub: Sync Models` (design)

Date: 2026-11-10. Status: draft for approval.

## Intent and why

The HTTP server is a client-agnostic ACP gateway. Today its Models page owns
Copilot knowledge: `POST /api/action {"type":"syncModels"}` refreshes the agents
*and* rewrites `~/.copilot/providers.json` and the extension's `package.json`
(`src/hosts/http/modelsSurface.ts` → `apply()` → `src/hosts/http/applyNames.ts`).
A rename on the page writes both files too.

The user wants the server to stop being a Copilot client: the page button becomes
**Refresh** (fetch the agents' models again, nothing else), and pushing the names
into the two Copilot surfaces becomes an explicit VS Code command, **ACP Hub:
Sync Models**, that updates the VS Code model picker and the Copilot CLI's
`providers.json`.

## Goals

- The page's Models section has a **Refresh** button that only re-reads each
  usable agent's models through `ModelCatalog` and repaints.
- Saving a provider or model name on the page stores the override and nothing else.
- A new command `acpHub.syncModels`, titled **ACP Hub: Sync Models**, which:
  1. asks the server to refresh the agents' models,
  2. writes `~/.copilot/providers.json` (or `COPILOT_PROVIDERS_CONFIG`) from the
     models the server now publishes,
  3. writes the provider `displayName`s into the extension's `package.json`,
  4. re-lists this window's model providers so the picker shows the new names,
  5. reports each target's outcome, and offers **Reload Window** when the manifest
     changed.
- The server keeps no path, no file write, and no Copilot-CLI or VS Code concept.

## Non-goals and anti-goals

- No new model-name editing UI, and no change to agent ids, `vendor` ids, wire ids
  (`<agent>/<model>`), efforts or context windows.
- Not a general `providers.json` editor: entries this extension did not write are
  left alone.
- No live push into another window or a running CLI: a window reload is still
  needed for provider headings, a CLI restart for `providers.json`.
- Anti-goal: a Sync that silently half-works. Each target reports its own outcome.

## Constraints

- `src/hosts/http` may not import `vscode`; the extension host owns the Copilot
  files. `src/hosts/vscode` already holds `serverClient.ts` (`listModels`),
  `serverLink.ts` (`ensure()` → endpoint with `baseUrl` and `token`) and
  `serverProvider.ts` (`refresh()` fires `onDidChangeLanguageModelChatInformation`).
- Model names reach the picker through `GET /v1/models` (`acp.name`); provider
  headings come from `package.json`, which VS Code reads before the extension
  starts, so a reload is required for a rename.
- The provider names the user chose live in the shared state store under
  `server.modelNames` (`ModelNames`), which both the server and this window can
  read (`src/extension.ts` already opens the same store).
- The ids of the entries the CLI file already has are remembered in
  `server.cliProviders`, so a later sync replaces its own entries only.

## Approaches

1. **Move the writes into the VS Code host (chosen).** The page keeps a
   client-neutral Refresh; a new `src/hosts/vscode/syncModels.ts` writes both
   files; a client-neutral `POST /v1/models/refresh` route lets any client ask for
   a fresh model read. The server loses `applyNames.ts`, the two file options, and
   every path it held. Most files touched, but the boundary ends up where the user
   wants it.
2. **Keep the writers in the server; the command calls the existing
   `/api/action` sync and re-lists providers.** Half the diff, but the server keeps
   `~/.copilot/providers.json` and `package.json`, so the stated problem stays.
3. **Write only `providers.json` from the command; drop the manifest sync.** Least
   work, but provider renames never reach the VS Code picker headings.

## Design

**Server.** `ModelsSurface` (`src/ui/messages.ts`) loses `sync()` and gains
`refresh(): Promise<string>`; `createModelsSurface` loses `providersFile`,
`packageJson` and `apply()`, and Save becomes store-only. `HttpServerOptions`
loses `providersFile` and `packageJson`; `copilotProvidersFile()` and
`manifestPath()` go. `src/hosts/http/wire.ts` gains
`MODELS_REFRESH_ROUTE = '/v1/models/refresh'`, handled like `WARM_ROUTE`: it
refreshes every usable adapter's models through `ModelCatalog.refresh()` and
answers `{ refreshed: string[] }` with the agent ids that answered, so the
extension can report what it did.

**Page.** `renderModels` draws a **Refresh** button (`data-action="refreshModels"`)
and the busy label "Refreshing models…"; `ControlState.syncing` becomes
`refreshing`, `FromWebview` gains `refreshModels`, and the notice after Save or
Refresh no longer promises a reload — it says the name shows up where the client
syncs it.

**Command.** `acpHub.syncModels` lives in `src/extension.ts` and calls
`syncModels({ endpoint, agents: REGISTRY.agents, names, state, packageJson, providersFile, log })`
from the new `src/hosts/vscode/syncModels.ts`, which returns the lines to report:

1. `POST /v1/models/refresh` on the endpoint (it is a background call: a stopped
   server is not started just to sync).
2. `GET /v1/models`, grouped by `owned_by`; each group with models becomes one CLI
   provider named `names.providerName(agentId, adapter.displayName)`, with one
   entry per model: `id` = the shown name made slash-free and unique,
   `provider` = that name, `wireModel` = `<agentId>/<value>`; `baseUrl` and
   `bearerToken` come from the endpoint.
3. The provider names, written as `displayName` in `package.json` beside the
   extension bundle, keeping indentation and line endings.
4. The window re-lists (`provider.refresh()` per agent), and a manifest change adds
   a **Reload Window** button to the confirmation.

Entries the file already holds from a previous sync (`server.cliProviders`) and the
legacy `acp-hub` provider are replaced; anything else is kept. A file that is not a
JSON object is refused and left as it was.

**Tests.** `modelsSurface.test.ts` covers refresh without any file; a new
`syncModels.test.ts` covers the two writers and the grouping over temp files;
`server.test.ts` drops the file options and covers the refresh route;
`controlPage.test.ts`, `modelsPage.test.ts`, `extension.test.ts` and
`serverProvider.test.ts` follow the renamed action and the new command.

**Docs.** `README.md` and `docs/copilot-cli-gateway.md` swap "Sync" for
"ACP Hub: Sync Models" on the command palette and "Refresh" on the page;
`CHANGELOG.md` gets the entry.

## Left to the builder

Exact notice and confirmation wording; whether the refresh route reports the agents
that failed or only those that answered; the module split inside
`src/hosts/vscode/syncModels.ts`.
