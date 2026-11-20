# Multiple accounts per agent (design)

Date: 2026-11-21. Status: draft for approval.

## Intent and why

A user can hold more than one subscription for the same agent, for example two
Claude plans on two Claude accounts. Today the hub serves exactly one account per
agent, so the second subscription is unusable from Copilot. The user wants to add
any number of extra accounts to Claude and Codex, sign each one in separately,
and pick a model from a specific account in the VS Code model picker, in
subagent model lists, in the Copilot CLI and on the OpenAI-compatible endpoint.

## Goals

- **N accounts per agent** for **Claude** and **Codex**. Each extra account has its
  own login, saved API key, auth preference, on/off switch, usage figures, saved
  chats and running process.
- **One sidebar card per agent** (mockup option B), with the accounts listed inside
  it: each account row shows its name, sign-in state, its own usage bars and an
  on/off switch. **+ Add account** is on the card.
- **Settings stay hidden until ⚙ is clicked**, as today. Behaviour settings are
  shared by all of an agent's accounts; account settings are per account.
- **Each account is its own model-picker group** in VS Code, named
  `Claude Agent · Work`, and its own provider in the Copilot CLI.
- **Each account is its own agent id on the endpoint**: models are published as
  `claude-work/claude-opus-4-7`, and a chat request naming that id runs on that
  account.
- **Switching an account off takes effect at once** in the endpoint and in the
  VS Code picker, with no reload.
- **Removing an account deletes its login and its saved chats.**
- **The existing account is untouched**: it keeps the id `claude` / `codex`, the
  group `Claude Agent` / `Codex Agent`, its login (`~/.claude`, the existing
  `codex-home`), its saved chats and its model ids. It appears in the account list
  as **Default**.

- **Windows only for now.** Extra accounts are offered only when the server runs
  on Windows (`process.platform === 'win32'`).
  - On other platforms the card shows no **+ Add account**, and any account
    records in `config.json` are ignored, with one warning in the log.
  - Login isolation has been reasoned about for Windows only (`CLAUDE_CONFIG_DIR`
    holds `.credentials.json` there). macOS keychain behaviour is unverified.

## Non-goals

- **macOS and Linux**, until Claude's per-folder login is verified there.
- **Google.** Antigravity CLI 1.5.3 keeps its Google login in one fixed Windows
  Credential Manager entry (`gemini:antigravity`) and ignores `GEMINI_HOME`; a
  second sign-in would overwrite the first (verified 2026-11-20 by running
  `agy models` under an empty `GEMINI_HOME` and under an empty `USERPROFILE`:
  both listed models). Google gets neither extra accounts nor extra API keys.
- **Renaming an account.** The name is fixed when the account is added; a
  different name means removing it and adding it again.
- **Different behaviour settings per account** (effort, tool search, thinking,
  system prompt replacement, live chat limit, idle timeouts).
- **Routing or load-balancing between accounts.** Nothing picks an account for the
  user or falls over to another one when a plan runs out.
- **Generic manifest agents** (`registry/agents.json` entries without a built-in
  adapter).

## Anti-goals

- A change to any id the existing account has today: its model ids, vendor id,
  state keys, storage folder or config keys. Saved chats, custom agent files and
  subagent references that name `Claude Agent/...` must keep working.
- An account whose login silently leaks into another, for example a sign-in
  that writes to `~/.claude` while it was meant for `Work`.
- Downloading the agent program once per account.
- A model from a switched-off account staying in the VS Code picker.

## Constraints (from the code and the spikes)

- **Everything is keyed by agent id already.** State keys
  (`signedIn.<id>`, `server.models.<id>`, `acpHub.savedSessions.<id>`,
  `acpHub.forkNotice.<id>`), secrets (`host.secrets.get(id)`), config keys
  (`agents.<id>.<key>`, `src/core/settings.ts`), usage (`UsageStore`,
  `UsageLedger`), model names (`ModelNames`), the endpoint (`splitModelId` in
  `src/hosts/http/server.ts` splits at the first `/`) and the CLI providers
  (`syncModels.ts` groups by `owned_by`). An account that is an agent id of its own
  gets all of this unchanged.
- **The adapter id doubles as the install folder.** `installers.ts` installs into
  `<agentsRoot>/<adapter.id>` and `headless.ts` gives the launch the same folder as
  `storageDir`.
- **Composition is fixed at server start.** `createHeadlessComposition` builds one
  `ChatService` per adapter, and `ControlService`, `createUsageHistorySurface` and
  the HTTP routes take the adapter list once.
- **Login isolation.**
  - Claude: `CLAUDE_CONFIG_DIR` relocates the whole Claude Code config, including
    `.credentials.json` on Windows, the only platform this design targets.
    `signInCompleted` in `src/adapters/claude.ts` reads `process.env.CLAUDE_CONFIG_DIR`
    and the sign-in command in `src/core/auth.ts` / `headless.ts` runs with the
    server's own environment: both assume one login folder.
  - Codex: `launch` already sets `CODEX_HOME = <storageDir>/codex-home`, and the
    ChatGPT sign-in runs inside the agent (`authenticate` with `chat-gpt`), so a
    different `storageDir` is a different login.
- **VS Code picker groups are static.** `contributes.languageModelChatProviders`
  is read from the extension's `package.json` when VS Code starts, and
  `registerLanguageModelChatProvider` only works for a declared vendor.
  `writeVendorNames` in `src/hosts/vscode/applyNames.ts` already rewrites that file
  at runtime and offers **Reload Window**. `activationEvents` contains
  `onStartupFinished`, so a new vendor needs no activation event of its own.
- **The spike (2026-11-21)** declared a second vendor `Claude Agent · Work` and
  registered a provider for it:
  - the picker showed it as its own group;
  - `·` is accepted in a vendor id;
  - the subagent model list names models as `<vendor id>/<model id>`, for
    example `Claude Agent · Work/claude-opus-4-7` beside
    `Claude Agent/claude-opus-4-7`.
  So the vendor id, not the heading, is what references depend on.
- **The window follows the server live.** `SidebarRelay` subscribes to
  `/api/events` at activation, and `extension.ts` calls `provider.refresh()` for
  every agent `changedAgents` reports (install, enabled, signed in, saved key).
  But `ServerProvider.list` keeps offering the last list when the server returns
  none for an agent, so a switched-off agent's models stay in the picker today.
- **`npm run generate:check`** compares the repository's `package.json` with
  `registry/agents.json`. A runtime rewrite must only ever touch the installed
  copy beside the bundle, never the repository's file during development.

## Approaches

1. **An account is an agent id of its own; the sidebar groups them (chosen).**
   Each account is a copy of the built-in adapter with its own `id`,
   `displayName` and `vendor`, its own `ChatService`, its own storage folder and
   its own login folder. The program is installed once per agent type. Almost
   every store already keys by id. The work is in the composition, the installers,
   the settings lookup, the sidebar and the manifest rewrite.
2. **One agent per type that routes to N accounts inside.** Rejected: the model
   id would need an account part (`claude/work/opus`), which breaks
   `splitModelId`, and usage, sign-in state, secrets, model names and CLI
   providers would all need an account dimension.
3. **Each account a fully separate agent.** Rejected: N downloads of each program
   and a separate copy of every setting, which contradicts the shared settings of
   option B.

The user picked option 1.

## Design

### The account record

- **Where accounts are kept:** in the shared store's `config.json` under
  `accounts.<agentType>`, as a list of `{ id, name }`, for example
  `accounts.claude = [{ "id": "claude-work", "name": "Work" }]`.
  - The default account is not listed: it is the agent type itself.
  - Both the server and the window read the list from there, the window
    synchronously at activation.
- **Name rules:** letters, digits, spaces and hyphens, 1–20 characters.
  - Unique within the agent type, case-insensitively.
  - Not `Default`.
- **The account's id:** `<agentType>-<slug>`, where the slug is the name in lower
  case with runs of spaces and hyphens turned into one hyphen.
  - An id already in use by any agent or account is refused, so `codex` can never
    be produced from a Claude name.
  - An id never contains `/`.
- **Derived names:**
  - vendor id and group heading: `<Type displayName> · <name>`, for example
    `Claude Agent · Work`;
  - endpoint id: `claude-work`;
  - CLI provider name: same as the vendor id unless renamed on the Models page
    (see *My calls*).

### Adapters and the composition

- **The adapter copy:** a factory `accountAdapter(base, account)` returns
  `{ ...base, id, displayName, vendor }` and adds an `installId` field.
  - `installId` is the base id, for example `claude`, and the base adapter's own
    `installId` is its own id.
  - `installers.ts` uses `installId` instead of `id` for the install folder, for
    `findInstalled`, `installAgent` and `uninstallAgent`. The default accounts keep
    their folders, so nothing moves.
  - `AgentAdapter` gains the optional `installId` and a new optional
    `accountFolder(storageDir): Record<string, string>` hook, or an equivalent:
    the environment that points the agent at the account's login.
- **Claude's login folder:**
  - Extra accounts set `CLAUDE_CONFIG_DIR = <agentsRoot>/<accountId>/claude-config`.
  - The default account sets nothing, so it stays on `~/.claude`, or on whatever
    `CLAUDE_CONFIG_DIR` the user already has.
  - `signInCompleted` must look at the account's folder, not
    `process.env.CLAUDE_CONFIG_DIR`, so it takes the launch context or the folder.
  - Claude's sign-in stays as today: the server hands out a command to paste into
    a terminal (`headless.ts`, the `terminal` branch), and the user runs it. For an
    extra account that command must set `CLAUDE_CONFIG_DIR` for the account, in
    syntax that works in the user's shell. No terminal is opened by the extension;
    `signInCompleted` is fixed only so it is right if a caller ever uses it.
- **Codex's login folder:** no change. The account's `storageDir`,
  `<agentsRoot>/<accountId>`, gives it its own `codex-home`.
- **A live adapter list:** `createHeadlessComposition` gets
  `addAccount(adapter)` / `removeAccount(id)`.
  - Adding creates the account's `ChatService` and updates the list that
    `ControlService`, the usage history surface, `ModelCatalog` and the HTTP routes
    iterate.
  - Those take a getter instead of a fixed array.
  - At start the composition builds the base adapters plus one copy per account
    in `config.json`.
- **Settings lookup:** `readAgentSettings` reads each key from the account's id
  first and, for keys that are not per-account, from the agent type's id.
  - Per-account keys are `enabled` and `authPreference`. The API key is already
    per id in secrets.
  - Every other key in the registry is shared and is only ever written under the
    agent type's id.
- **The two switches:** the account's switch is `agents.<accountId>.enabled`.
  - For Default that is the existing `agents.claude.enabled` / `agents.codex.enabled`,
    so today's value keeps meaning what it means now: the one existing account is
    on or off.
  - The card's switch is a new key, `agents.<type>.accountsEnabled`, which
    defaults to `true`, so no migration is needed.
  - A service is enabled when both its account key and its type's
    `accountsEnabled` are not `false`. The `isEnabled` passed to each
    `ChatService` in `headless.ts`, and `ControlService`, read both.
- **No inherited credentials for extra accounts.** An extra account's environment
  drops the key variables it could inherit from the server's process.
  - Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.
  - Codex: `CODEX_API_KEY`, `OPENAI_API_KEY`.
  - Only the key saved for that account is set, so a key in the user's shell
    never makes Work bill someone else's account.
  - Default keeps today's behaviour.

### Server control surface

- **`ControlAction`** gains `addAccount { agentId, name }` and
  `removeAccount { agentId }`. The existing `addAgent` / `removeAgent` actions
  are a different feature and stay as they are.
- **Add:**
  - validate the name;
  - write the record to `config.json`;
  - add the adapter to the composition;
  - push the new state.
  - The new account starts signed out and switched on. It lists no models until
    it is signed in, so it shows nothing in the picker until then.
- **Remove:**
  - stop the account's processes and close its sessions;
  - delete `<agentsRoot>/<accountId>`, which holds the login folder, Claude's
    transcripts under `claude-config/projects`, the Codex home and the logs;
  - delete the secret `<accountId>`;
  - delete the state keys `signedIn.`, `server.models.`, `acpHub.savedSessions.`
    and `acpHub.forkNotice.` for that id, and its entries in `ModelNames`;
  - delete the `agents.<accountId>.*` config keys and the account record;
  - drop the adapter from the composition.
  - The usage ledger keeps its past rows (see *My calls*).
  - The sidebar asks for confirmation: "Remove Work? Its sign-in, API key and
    saved chats are deleted."
- **`ControlState`:**
  - Each agent type's card carries an `accounts` list. Each entry has its own id,
    name, sign-in view, saved-key flag, API-key field, `enabled` flag, usage view,
    busy text, sign-in URL and error.
  - Shared settings stay on the card; per-account settings move to the account.
  - The Default account is the first entry and carries the agent type's id.
  - The **Usage** page lists accounts as separate agents, labelled
    `Claude Agent · Work`.
- **Uninstalling an agent type** keeps today's behaviour: it deletes
  `<agentsRoot>/<type>`.
  - That folder also holds Default's own data, so Default's Codex login
    (`codex-home`) goes with it, as it does today.
  - Extra accounts live in their own folders, so their logins, saved keys and
    settings are kept.
  - Changing what uninstall deletes for Default is out of scope.

### Sidebar (option B)

- **The card:**
  - head: the agent's name, its **Enabled** switch and ⚙;
  - the install badge;
  - then one row per account: name, its own switch, a **Signed in** or
    **Sign in** badge/button, **Use API key**, and its usage bars and
    **Refresh usage**.
- **⚙ panel:**
  - closed by default, as today;
  - the shared settings;
  - then a "Per account" part with each account's auth preference and
    **Remove account** (not offered for Default);
  - and **+ Add account**, a text field with the rules shown and an **Add**
    button.
- **Switches:**
  - the card's **Enabled** switch turns every account of the agent off;
  - an account's switch turns that account off;
  - an account serves only when both are on.
- **Google's card** keeps today's layout: no account list and no **+ Add account**.

### VS Code window

- **Providers:** at activation the window registers one `ServerProvider` per base
  agent plus one per account in `config.json`, each with
  `agentId = <accountId>` and `vendor = <Type displayName> · <name>`.
- **Manifest sync:**
  - at activation, and whenever the relay's state shows a different set of
    accounts, the window computes the vendor list (base vendors plus account
    vendors) and compares it with `contributes.languageModelChatProviders` in the
    installed `package.json` beside the bundle;
  - if they differ it rewrites that list, keeping indentation and line endings as
    `writeVendorNames` does, and offers **Reload Window** with "Reload to show
    the Work account in the model picker" or "…to remove it";
  - it never writes when the extension runs from a development folder, which
    `context.extensionMode !== Production` detects.
- **After an extension update** the fresh `package.json` has no accounts again.
  The activation check rewrites it and asks for one reload. Until then the
  accounts' providers cannot register, which is logged as a warning, not thrown.
- **A switched-off account leaves the picker at once:**
  - `ServerProvider` gets an `isOffered()` from the relay's last state: the
    agent and the account are on and installed;
  - when that is false, `provideLanguageModelChatInformation` returns `[]` and
    skips the saved-list fallback;
  - `changedAgents` already reports the change, which fires the refresh;
  - the fallback stays for a cold or unreachable server;
  - this also fixes the same problem for a base agent switched off today.
- **Add or remove with other windows open:** every open window gets the same
  relay state. Each compares and prompts on its own; the file is only written if
  it still differs.
- **Sync Models** (`syncModels.ts`) iterates the base agents and every account,
  so the Copilot CLI gets one provider per account. Removed accounts disappear
  on the next sync, because `writeCliProviders` replaces its own entries.

### Endpoint

There's no new route and no format change. `GET /v1/models` lists every offered
account's models under its own id. `POST /v1/chat/completions` with
`claude-work/...` routes through `composition.serviceOf('claude-work')`. A
switched-off account answers 404 with the existing "disabled" message, and a
removed one with "Unknown agent".

## My calls (not asked; correct me if any is wrong)

- The account list lives in `config.json` (`accounts.<type>`), beside the other
  settings, not in `state.json`.
- Per-account settings are only `enabled`, `authPreference` and the API key;
  `maxChatSessions` is shared and applies per account, since each account runs its
  own processes.
- The usage ledger keeps a removed account's past rows, so the Usage chart history
  doesn't change. Adding an account later under the same name continues the same
  series.
- The Models page's existing provider rename keeps working per id, for accounts
  too. It changes only the group heading and the CLI provider name, never the
  vendor id, so subagent references are safe.
- The account limit is not enforced. A soft warning appears past 10 accounts per
  agent, because each holds its own processes.
- The card's switch is a new key (`accountsEnabled`), and Default's row switch
  is the existing `enabled` key, so no setting has to be migrated.
- Extra accounts never use API keys inherited from the server's environment.
- Claude sign-in stays copy-and-paste; only the command gains `CLAUDE_CONFIG_DIR`.
- Uninstall keeps deleting `<agentsRoot>/<type>`, Default's Codex login included,
  as today.

## Left to the builder

- Module boundaries for the account record, the adapter factory and the manifest
  sync, and whether `installId` lives on `AgentAdapter` or beside it.
- How the composition's live adapter list is exposed (getter, event, or both).
- The exact shell syntax of the Claude sign-in command per platform.
- Wording of prompts, confirmations and validation errors.
- Test placement. Expected coverage:
  - the adapter factory and the id/slug rules;
  - per-account settings fallback;
  - install sharing;
  - add/remove in `ControlService` against a temp store, including what removal
    deletes;
  - `ServerProvider` returning `[]` for a switched-off account but the saved list
    for a cold server;
  - the manifest diff/rewrite against a temp `package.json`;
  - `syncModels` with accounts;
  - an endpoint test routing `claude-work/...` to its own service.
- `README.md`, `docs/copilot-cli-gateway.md` and `CHANGELOG.md` updates.
