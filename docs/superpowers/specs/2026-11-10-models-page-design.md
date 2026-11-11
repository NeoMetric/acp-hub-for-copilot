# Models page: custom provider and model names (design)

Date: 2026-11-10. Status: draft for approval.

## Intent

The user picks models in two places: VS Code's Copilot Chat picker (provider headings "Claude Agent", "Codex Agent", "Google Agent", and the model names under them) and the Copilot CLI picker (fed by `~/.copilot/providers.json`). Today both show whatever the agents report, and the CLI list only changes when a PowerShell script is run by hand. The user wants one page where they set the **provider name** and each **model name** they see in both pickers, and a **Sync** button that fetches the current models and pushes the names to both. Changes may need a VS Code window reload or a CLI restart; the page says so after saving.

## Goals

- A Models page in the existing control page (so it works in the VS Code sidebar and in a browser tab) listing each agent's provider name and its models, each editable, with the agent's own name shown as the placeholder/default.
- Overrides are saved on the server and survive restarts.
- Model names reach VS Code through `/v1/models`.
- Sync fetches the agents' current models, then writes `providers.json` for the CLI and the provider `displayName` entries in the extension's `package.json` for VS Code.
- After Save and after Sync the page shows a notice: reload the VS Code window and restart the Copilot CLI for the change to take effect.
- Clearing a name restores the default.

## Non-goals and anti-goals

- No live update of an open VS Code window or a running CLI.
- No change to agent ids, the `vendor` ids in `package.json`, wire model ids (`<agent>/<model>`), efforts, or context windows. Only display names change.
- Not a general `providers.json` editor: entries the page did not write are left alone.
- Anti-goal: a Sync that silently half-works. Each target (providers.json, package.json) reports its own success or failure.

## Constraints (from the code)

- The server publishes `GET /v1/models` as `{ id: "<agent>/<model>", owned_by: "<agent>", acp: { name, ... } }` (`src/hosts/http/server.ts`, `ModelCatalog.wireOf`). The VS Code provider builds its picker entries from `acp.name`, so an override applied there reaches VS Code with no extension change.
- VS Code provider headings come from `package.json` `contributes.languageModelChatProviders[].displayName`, which VS Code reads before the extension starts. `vendor` must stay `vendorOf(agent.id)` (`src/core/vendors.ts`). A reload is required. In an installed VSIX the edit is lost on extension update; in a source checkout it persists until `npm run generate` regenerates the manifest, which resets the names to the registry defaults (Sync again restores them). `generate:check` will report a drift while an override is applied; this is expected and documented.
- The control page state/actions are the shared `ControlState` / `ControlAction` in `src/ui/messages.ts`, served over `/api/state` and `/api/action` and relayed by the sidebar; any new state or action must go through both transports.
- The Copilot CLI provider file is `~/.copilot/providers.json`, or `COPILOT_PROVIDERS_CONFIG`. The existing script (`scripts/sync-copilot-models.ps1`) shows the shape: `providers: [{ name, type: "openai", baseUrl, bearerToken }]` and `models: [{ id, provider, wireModel }]`, where `id` has no slash.

## Approaches considered

1. **Server does everything (chosen).** Overrides in the server's store; the page edits them; Save changes what `/v1/models` publishes; Sync also writes `providers.json` and `package.json`. Works from the sidebar and from a browser. Cost: the server edits a file in the extension folder.
2. Extension edits `package.json` on start. Rejected: VS Code has already read the manifest by then (two reloads needed) and a browser Sync could never reach it.
3. No heading edits. Rejected: the user wants the provider name changed in both places.

## Design

**Store.** One saved value in the server's state store, `server.modelNames`: `{ providers: { [agentId]: string }, models: { [agentId]: { [modelValue]: string } } }`. Absent key means default. Names are trimmed, 1 to 80 characters, no control characters; an empty string clears the override. Within one agent, two models may not end up with the same name (the CLI id is derived from the name); the save is refused with a message.

**Publishing.** `ModelCatalog.wireOf` replaces `acp.name` with the override when there is one. `id` and `owned_by` are untouched.

**Page.** `ControlState` gains `models`: per agent, `{ agentId, provider: { name, default }, models: [{ value, name, default }] }`, built from the saved model lists the catalog already keeps, plus a `notice?: string`. New actions: `setProviderName { agentId, name }`, `setModelName { agentId, model, name }`, `syncModels`. The Models view is reached from the existing page header (a toggle next to the agent list) and has one section per agent with an editable provider name, a row per model, and a Sync button. Agents with no saved models show their provider name only.

**Save and Sync (builder-check calls, mine).** Saving a name stores it and then runs the same apply step as Sync, minus the refresh, so one click reaches `/v1/models`, `providers.json` and `package.json`, and the notice then applies to both. Sync is refresh plus apply. The server and its targets are on one machine: the server listens on loopback only, so `baseUrl` is `http://127.0.0.1:<bound port>/v1` and remote or container servers are out of scope. Provider names must be unique across agents (a duplicate is refused); spaces are allowed, since the CLI only references the name. Agents that are disabled or not installed are left out of `providers.json`, as VS Code leaves them out of its picker; if an enabled agent's model lookup fails, its saved list is used.

**Apply and refresh steps.** In order: (1) refresh each installed, enabled agent's model list through the catalog (Sync only); (2) write `providers.json`: one provider per agent named by its provider name, `baseUrl` this server's `/v1`, `bearerToken` this server's token, and one model per entry with `id` = the model name made slash-free and unique, `provider` = that provider name, `wireModel` = the real id; entries a previous Sync wrote (tracked in the store as `server.cliProviders`) and the legacy `acp-hub` provider are replaced, everything else is kept; (3) update `displayName` of each matching `languageModelChatProviders` entry in the `package.json` beside the bundle (found the way the page bundle is), restoring the registry name where no override exists. Each step's outcome goes into the notice; a failure in one does not stop the others.

**Replacing the script.** `scripts/sync-copilot-models.ps1` is removed and the README/docs point at the page.

**Auth.** Nothing new: the new actions ride the existing token or cookie gate.

## Tests

Unit tests over a temp store and temp files: store validation and duplicate refusal; `/v1/models` with and without overrides; Sync output for `providers.json` (our entries replaced, others preserved, token and base URL right) using `COPILOT_PROVIDERS_CONFIG`; `package.json` update and restore, and a missing or read-only manifest reported without failing the other targets; the new actions over `/api/action`; the page renders the Models view.

## Left to the builder

The page layout and wording; exact notice text; how the slash-free CLI id is derived and de-duplicated; where the `package.json` path is resolved from; how the sidebar relay forwards the new actions.
