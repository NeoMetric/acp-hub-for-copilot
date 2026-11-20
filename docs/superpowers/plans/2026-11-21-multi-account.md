# Multiple Accounts per Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude and Codex hold N extra accounts, each its own agent id, picker group and endpoint id, grouped under one sidebar card.

**Architecture:** An extra account is a copy of the built-in adapter with its own `id`/`displayName`/`vendor`, an `installId` pointing at the shared install, and an environment that isolates its login. The server composition holds a live adapter list it mutates on add/remove; every store already keyed by agent id works unchanged. The window registers one provider per account and rewrites the installed `package.json` vendor list, prompting a reload.

**Tech Stack:** TypeScript, Node, VS Code extension API, vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-multi-account-design.md`

## Global Constraints

- Windows only: account features are active only when `process.platform === 'win32'`; elsewhere no **+ Add account** and stored records are ignored with one warning.
- Account name: letters, digits, spaces, hyphens; 1–20 chars; unique per type case-insensitively; not `Default`.
- Account id: `<typeId>-<slug>`, slug = lower-cased name with runs of spaces/hyphens collapsed to one `-`; must not equal any existing adapter or account id; never contains `/`.
- Vendor id and group heading of an account: `<vendorOf(typeId)> · <name>` (U+00B7 middle dot, spaces either side).
- Account records: `config.json` key `acpHub.accounts.<typeId>` = `[{ "id": "...", "name": "..." }]`.
- Per-account setting keys: `enabled`, `authPreference`. All other keys read and written under the type id.
- Card switch key: `agents.<typeId>.accountsEnabled` (default `true`). Account switch: `agents.<accountId>.enabled`. Serving requires neither to be `false`.
- Claude extra account: `CLAUDE_CONFIG_DIR = <agentsRoot>/<accountId>/claude-config`; unset inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.
- Codex extra account: no extra variable (its `storageDir` gives its own `codex-home`); unset inherited `CODEX_API_KEY`, `OPENAI_API_KEY`.
- The default accounts keep every id, key, folder and environment they have today.
- `src/core`, `src/sidebar`, `src/ui` never name an agent (`test/unit/noAgentBranching.test.ts`).
- Never write the repository's `package.json`: the manifest rewrite runs only when `context.extensionMode === vscode.ExtensionMode.Production`.

## Review Focus

1. **Names that collide after slugging** (`Work`, `work`, `WORK `, `Work--1` vs `Work 1`): the second is refused with a message; no second id is created. → Task 1 test `refuses a name whose id is taken`.
2. **A hand-edited or stale `accounts.<type>` record** (missing name, id containing `/`, duplicate id, id not starting with `<type>-`): skipped with a warning, the server still starts. → Task 3 test `skips account records it cannot use`.
3. **Removing an account while a chat runs on it:** sessions are closed before the folder is deleted, the delete retries on Windows file locks, and a later request for `claude-work/...` answers `Unknown agent`. → Task 4 test `removeAccount closes sessions before deleting the folder`, Task 3 test `routes an account's model and forgets a removed one`.
4. **Extension updated, `package.json` back to three vendors, accounts still in `config.json`:** activation rewrites the vendor list and asks for one reload; registering a provider for an undeclared vendor is caught and logged. → Task 6 test `activation adds missing account vendors and asks for a reload`.
5. **Account switched off while the window has no server state yet** (cold start): the saved list is still offered; once the relay state says off, the picker gets `[]`. → Task 6 test `offers the saved list while the state is unknown`.

---

### Task 1: Account records, ids and adapter copies (core)

**Files:**
- Create: `src/core/accounts.ts`
- Modify: `src/core/adapter.ts` (`AgentAdapter`, `LaunchSpec`)
- Modify: `src/core/settings.ts` (`readAgentSettings`)
- Modify: `src/core/installers.ts` (install folder by `installId`)
- Test: `test/unit/accounts.test.ts` (new), `test/unit/settings.test.ts`, `test/unit/installers.test.ts`

**Interfaces:**
- Produces, in `src/core/adapter.ts`:
  - `AgentAdapter.installId?: string`: the id whose folder holds the program; absent means `id`.
  - `AgentAdapter.accountName?: string`: set only on extra-account copies.
  - `AgentAdapter.accounts?: AccountSupport`, where `interface AccountSupport { environment(storageDir: string): Record<string, string>; inheritedCredentials: readonly string[] }`.
  - `LaunchSpec.unsetEnv?: string[]`: names removed from the inherited environment before the adapter's own env is applied.
- Produces, in `src/core/accounts.ts`:
  - `interface AccountRecord { id: string; name: string }`
  - `const PER_ACCOUNT_SETTINGS: ReadonlySet<string>` = `enabled`, `authPreference`
  - `const ACCOUNTS_ENABLED_KEY = 'accountsEnabled'`
  - `function accountsKey(typeId: string): string` → `accounts.${typeId}`
  - `function accountsSupported(adapter: AgentAdapter, platform?: NodeJS.Platform): boolean`: `!!adapter.accounts && !adapter.accountName && platform === 'win32'`
  - `function accountId(typeId: string, name: string): string`
  - `function validateAccountName(name: string, existing: readonly AccountRecord[], takenIds: ReadonlySet<string>, typeId: string): string | undefined`: returns an error message or `undefined`
  - `function accountVendor(typeVendor: string, name: string): string`
  - `function accountAdapter(base: AgentAdapter, account: AccountRecord): AgentAdapter`
  - `function readAccounts(config: ConfigReader, typeId: string, warn?: (message: string) => void): AccountRecord[]`
  - `function isServing(adapter: AgentAdapter, config: ConfigReader): boolean`
  - `function typeIdOf(adapter: AgentAdapter): string` → `adapter.installId ?? adapter.id`

- [ ] **Step 1: Write the failing tests** in `test/unit/accounts.test.ts`

```ts
it('derives the id from the name', () => {
	expect(accountId('claude', 'Work')).toBe('claude-work');
	expect(accountId('claude', 'My  Team - 2')).toBe('claude-my-team-2');
});
it('refuses a name whose id is taken', () => {
	const existing = [{ id: 'claude-work', name: 'Work' }];
	const taken = new Set(['claude', 'codex', 'claude-work']);
	expect(validateAccountName('work', existing, taken, 'claude')).toMatch(/already/);
	expect(validateAccountName('WORK ', existing, taken, 'claude')).toMatch(/already/);
	expect(validateAccountName('Default', [], taken, 'claude')).toBeDefined();
	expect(validateAccountName('a/b', [], taken, 'claude')).toBeDefined();
	expect(validateAccountName('x'.repeat(21), [], taken, 'claude')).toBeDefined();
	expect(validateAccountName('', [], taken, 'claude')).toBeDefined();
	expect(validateAccountName('Team 2', [], taken, 'claude')).toBeUndefined();
});
it('copies an adapter as an account', () => {
	const base = adapter('claude', { accounts: { environment: dir => ({ CFG: `${dir}/cfg` }), inheritedCredentials: ['KEY'] } });
	const copy = accountAdapter(base, { id: 'claude-work', name: 'Work' });
	expect(copy).toMatchObject({ id: 'claude-work', installId: 'claude', accountName: 'Work', displayName: `${base.displayName} · Work`, vendor: `${base.vendor} · Work` });
	const spec = copy.launch({ entryPath: 'e', installDir: '', storageDir: 'S', settings: {}, workspaceFolder: '.' });
	expect(spec.env.CFG).toBe('S/cfg');
	expect(spec.unsetEnv).toEqual(['KEY']);
});
it('keeps a credential the account set itself', () => {
	const base = adapter('claude', { launch: () => ({ command: 'c', args: [], env: { KEY: 'saved' } }), accounts: { environment: () => ({}), inheritedCredentials: ['KEY'] } });
	const spec = accountAdapter(base, { id: 'claude-work', name: 'Work' }).launch(ctx);
	expect(spec.env.KEY).toBe('saved');
	expect(spec.unsetEnv ?? []).not.toContain('KEY');
});
it('supports accounts only on Windows, for a base adapter that declares them', () => {
	const base = adapter('claude', { accounts: { environment: () => ({}), inheritedCredentials: [] } });
	expect(accountsSupported(base, 'win32')).toBe(true);
	expect(accountsSupported(base, 'darwin')).toBe(false);
	expect(accountsSupported(adapter('google'), 'win32')).toBe(false);
	expect(accountsSupported(accountAdapter(base, { id: 'claude-w', name: 'W' }), 'win32')).toBe(false);
});
it('serves only when the account and its type are both on', () => {
	const base = adapter('claude');
	const copy = accountAdapter(base, { id: 'claude-work', name: 'Work' });
	expect(isServing(copy, config({}))).toBe(true);
	expect(isServing(copy, config({ 'agents.claude-work.enabled': false }))).toBe(false);
	expect(isServing(copy, config({ 'agents.claude.accountsEnabled': false }))).toBe(false);
	expect(isServing(base, config({ 'agents.claude.accountsEnabled': false }))).toBe(false);
	expect(isServing(base, config({ 'agents.claude.enabled': false }))).toBe(false);
});
```

(The tests use local `adapter()`, `ctx` and `config()` helpers in the same style as `test/unit/controlService.test.ts`; adapter ids in tests are variables built from strings such as `'cl' + 'aude'` only if the agent-name lint test scans `test/`. It does not, so plain literals are fine.)

In `test/unit/settings.test.ts`: `it('reads shared keys from the type and per-account keys from the account')`. With a copy of an adapter declaring `level` and `authPreference`, and config `agents.base.level = 'high'`, `agents.base-work.level = 'low'`, `agents.base-work.authPreference = 'oauth'`, it expects `{ level: 'high', authPreference: 'oauth' }`.

In `test/unit/installers.test.ts`: `it('installs an account copy into its type folder')`. `findInstalled` for `accountAdapter(npmBase, …)` resolves an `installDir` under `<storageDir>/<base id>`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/accounts.test.ts test/unit/settings.test.ts test/unit/installers.test.ts`
Expected: FAIL, `accounts.ts` is missing.

- [ ] **Step 3: Implement**
  - **`accountAdapter`:** wraps `launch`. It merges `base.accounts.environment(ctx.storageDir)` into `env`, and sets `unsetEnv` to the `inheritedCredentials` the base launch did not set itself.
  - **`readAgentSettings`:** looks each key up under `PER_ACCOUNT_SETTINGS.has(spec.key) ? adapter.id : typeIdOf(adapter)`.
  - **`installers.ts`:** uses `typeIdOf(adapter)` wherever it joins `adapter.id` onto `env.storageDir`.
  - **`readAccounts`:** drops an entry and calls `warn` when:
    - it is not an object with string `id` and `name`;
    - its `id` doesn't start with `${typeId}-`;
    - its `id` contains `/`;
    - its `id` repeats an earlier one.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/accounts.test.ts test/unit/settings.test.ts test/unit/installers.test.ts test/unit/noAgentBranching.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** `feat: account records and adapter copies`

### Task 2: Login isolation in the Claude and Codex adapters

**Files:**
- Modify: `src/adapters/claude.ts` (`accounts`, `signInCompleted`)
- Modify: `src/adapters/codex.ts` (`accounts`)
- Modify: `src/engine/acp/agentClient.ts` (`childEnv` honours `unsetEnv`)
- Modify: `src/core/auth.ts` (pass the launch env to `signInCompleted`)
- Modify: `src/core/adapter.ts` (`signInCompleted?(startedAt: number, env?: Record<string, string>): boolean`)
- Test: `test/unit/adapters/claude.test.ts`, `test/unit/adapters/codex.test.ts`, `test/unit/agentClient.test.ts`

**Interfaces:**
- Consumes: `AccountSupport`, `LaunchSpec.unsetEnv`, `accountAdapter` (Task 1).
- Produces: `claudeAdapter.accounts` and `codexAdapter.accounts`. `childEnv(command, adapterEnv, unsetEnv?: readonly string[])` deletes those names from the process-env base before spreading `adapterEnv`.

- [ ] **Step 1: Write the failing tests**
  - `claude.test.ts`:
    - `it('points an extra account at its own config folder')`: `accountAdapter(claudeAdapter, { id: 'claude-work', name: 'Work' }).launch({ …, storageDir: 'C:/hub/agents/claude-work' }).env.CLAUDE_CONFIG_DIR` equals `path.join('C:/hub/agents/claude-work', 'claude-config')`.
    - `it('leaves the default account on its own config')`: `claudeAdapter.launch(ctx).env.CLAUDE_CONFIG_DIR` is `undefined`.
    - `it('drops inherited Anthropic credentials for an extra account')`: `unsetEnv` equals `['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']` without a saved key. With `apiKey: 'sk-ant-x'`, `env.ANTHROPIC_API_KEY` is `'sk-ant-x'` and `unsetEnv` is `['ANTHROPIC_AUTH_TOKEN']`.
    - `it('checks the sign-in of the folder it was given')`: write `.credentials.json` in a temp dir, then `signInCompleted(0, { CLAUDE_CONFIG_DIR: dir })` is `true`, and `signInCompleted(Date.now() + 60_000, { CLAUDE_CONFIG_DIR: dir })` is `false`.
  - `codex.test.ts`: `it('drops inherited OpenAI credentials for an extra account')`: `unsetEnv` equals `['CODEX_API_KEY', 'OPENAI_API_KEY']`, and `env.CODEX_HOME` sits under the account's `storageDir`.
  - `agentClient.test.ts`: `it('removes the names a launch unsets from the inherited environment')`: with `process.env.ACP_TEST_SECRET = 'x'` and a launch spec `unsetEnv: ['ACP_TEST_SECRET']`, the spawned env lacks it. Use the same spawn-capture approach the file already uses.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/adapters/claude.test.ts test/unit/adapters/codex.test.ts test/unit/agentClient.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**
  - **Claude:** `accounts: { environment: dir => ({ CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config') }), inheritedCredentials: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] }`. `signInCompleted` reads `env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || ~/.claude`.
  - **Codex:** `accounts: { environment: () => ({}), inheritedCredentials: ['CODEX_API_KEY', 'OPENAI_API_KEY'] }`.
  - **`auth.ts`:** passes `adapter.launch(ctx).env` (plus `ELECTRON_RUN_AS_NODE`) as the terminal `env` and to `signInCompleted`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/adapters test/unit/agentClient.test.ts test/unit/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** `feat: isolate the login of an extra Claude or Codex account`

### Task 3: Live adapter list in the server composition

**Files:**
- Modify: `src/composition/headless.ts`
- Modify: `src/hosts/http/usageSurface.ts` (`agents` becomes `() => readonly {id, displayName}[]`)
- Test: `test/unit/engine/headlessWiring.test.ts`, `test/unit/usageSurface.test.ts`, `test/unit/server.test.ts`

**Interfaces:**
- Consumes: `readAccounts`, `accountAdapter`, `accountsSupported`, `isServing`, `typeIdOf` (Task 1).
- Produces:
  - **`HeadlessComposition.adapters`:** one array that the composition mutates in place, so every holder sees added and removed accounts.
  - **New `ControlHost` hooks** that the composition implements and Task 4 calls:
    - `accountAdded?(adapter: AgentAdapter): void` creates its `ChatService` and pushes the adapter.
    - `accountRemoved?(accountId: string): Promise<void>` closes the service and splices the adapter out.
  - **`HeadlessCompositionOptions.platform?: NodeJS.Platform`**, defaulting to `process.platform`, so tests can turn accounts on.

- [ ] **Step 1: Write the failing tests** in `headlessWiring.test.ts`, with a mock adapter that declares `accounts`:
  - `it('builds a service for each stored account')`: `config.json` holds `{ acpHub: { accounts: { mock: [{ id: 'mock-work', name: 'Work' }] } } }`, `platform: 'win32'`. Expects `composition.adapters.map(a => a.id)` to equal `['mock', 'mock-work']`, and `serviceOf('mock-work')` to be defined.
  - `it('ignores stored accounts off Windows')`: the same config with `platform: 'linux'` gives `['mock']`.
  - `it('skips account records it cannot use')`: a record with id `mock/x`, one missing `name`, and a duplicate id. Only valid ones are built, and `log` receives a `warn`.
  - `it('enables an account only when its type is on')`: with `agents.mock.accountsEnabled = false`, `serviceOf('mock-work')!.enabled` is `false`.
  - In `server.test.ts`, `it('routes an account\'s model and forgets a removed one')`: after `accountAdded`, `GET /v1/models` lists `mock-work/...`. After `accountRemoved('mock-work')`, `POST /v1/chat/completions` with `mock-work/x` answers 404 `Unknown agent "mock-work"`.
  - In `usageSurface.test.ts`: `it('names an agent added after the surface was built')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/engine/headlessWiring.test.ts test/unit/server.test.ts test/unit/usageSurface.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**
  - **Startup:** `adapters` starts as the base adapters plus `accountAdapter(base, record)` for each `readAccounts(host.settings, base.id, warn)`, only where `accountsSupported(base, platform)`. Off Windows, a non-empty record list logs one warning.
  - **Per-adapter service creation:** move it into a local `addService(adapter)`.
  - **Launch folder:** `resolveLaunch` keeps `storageDir: path.join(agentsDir, adapter.id)`, which is per account. `findInstalled` already uses `typeIdOf` (Task 1).
  - **`isEnabled`:** `() => isServing(adapter, host.settings)`.
  - **Claude terminal sign-in command:** for an adapter with `accountName`, prefix the command with `$env:NAME='value'; ` for each entry of `adapter.launch(launch).env` whose name is in `Object.keys(base.accounts.environment(''))`. The message names PowerShell.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/engine test/unit/server.test.ts test/unit/usageSurface.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** `feat: build and drop account services at runtime`

### Task 4: Add and remove accounts in the control service

**Files:**
- Modify: `src/engine/control/ControlService.ts`
- Modify: `src/engine/models/modelNames.ts` (`forget(agentId: string): Promise<void>`)
- Test: `test/unit/controlService.test.ts`, `test/unit/modelNames.test.ts`

**Interfaces:**
- Consumes: `accountId`, `validateAccountName`, `accountAdapter`, `readAccounts`, `accountsKey`, `accountsSupported`, `isServing`, `PER_ACCOUNT_SETTINGS`, `ACCOUNTS_ENABLED_KEY`, `typeIdOf` (Task 1); `ControlHost.accountAdded`, `accountRemoved` (Task 3).
- Produces, on `ControlSurface`:
  - `supportsAccounts(typeId: string): boolean`
  - `accounts(typeId: string): AccountRecord[]`
  - `addAccount(typeId: string, name: string): Promise<void>`, which rejects with the validation message
  - `removeAccount(accountId: string): Promise<void>`
  - `accountsEnabled(typeId: string): boolean`
  - `setAccountsEnabled(typeId: string, enabled: boolean): Promise<void>`
- Changed behaviour:
  - `isEnabled(id)` returns the account's own key: `agents.<id>.enabled ?? true`.
  - `writeSetting(id, key, value)` writes under `typeIdOf(adapter)` unless `PER_ACCOUNT_SETTINGS.has(key)`.
- `ControlServiceOptions` gains `platform?: NodeJS.Platform` and `storageRoot: string`, which is `agentsDir`, the folder removal deletes from. `install.storageDir` already is that folder, so use it.

- [ ] **Step 1: Write the failing tests** in `controlService.test.ts`, with a base adapter declaring `accounts`, `platform: 'win32'`, and a host spy:
  - `it('adds an account record and tells the host')`: `addAccount('base', 'Work')` writes `accounts.base = [{ id: 'base-work', name: 'Work' }]` via `writeConfig`. `host.accountAdded` gets an adapter with id `base-work`.
  - `it('refuses an account for an agent that has none, or off Windows')`: rejects for an adapter without `accounts`, and for `platform: 'darwin'`.
  - `it('removeAccount closes sessions before deleting the folder')`: the call order is `closeSessions('base-work')` → `accountRemoved('base-work')` → the folder `<storageDir>/base-work` is gone. Afterwards:
    - the secret `base-work` is deleted;
    - the state keys `signedIn.base-work`, `server.models.base-work`, `acpHub.savedSessions.base-work` and `acpHub.forkNotice.base-work` are `undefined`;
    - `writeConfig('agents.base-work', undefined)` was called;
    - the record is gone from `accounts.base`.
  - `it('refuses to remove the default account')`: `removeAccount('base')` rejects.
  - `it('writes a shared setting under the type')`: `writeSetting('base-work', 'level', 'high')` writes `agents.base.level`, and `writeSetting('base-work', 'authPreference', 'oauth')` writes `agents.base-work.authPreference`.
  - `it('switches every account of a type off at once')`: `setAccountsEnabled('base', false)` writes `agents.base.accountsEnabled = false` and calls `refreshAgent` for `base` and `base-work`.
  - In `modelNames.test.ts`: `it('forgets every name of an agent')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/controlService.test.ts test/unit/modelNames.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**
  - **Folder removal:** use `fs.promises.rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })`, as `uninstallAgent` does.
  - **Model names:** `new ModelNames(options.state).forget(id)`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/controlService.test.ts test/unit/modelNames.test.ts test/unit/controlTransport.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** `feat: add and remove accounts`

### Task 5: Sidebar card with accounts (option B)

**Files:**
- Modify: `src/ui/messages.ts`
- Modify: `src/ui/controlPage.ts`
- Modify: `src/ui/render.ts`
- Modify: `src/ui/page.ts`
- Modify: `media/sidebar.css`
- Test: `test/unit/controlPage.test.ts`, `test/unit/sidebarRender.test.ts`

**Interfaces:**
- Consumes: the `ControlSurface` additions (Task 4).
- Produces (the window relies on these in Task 6):
  - **`AgentCardState`:** stays one flat list, which keeps `changedAgents` and the relay unchanged. It gains:
    - `accountOf?: string`: the type id, set on an extra account's entry;
    - `accountName?: string`: set on an extra account's entry;
    - `accountsEnabled?: boolean`: set only on a type entry that supports accounts, and its presence means "draw as an account card";
    - `vendor: string`: the picker group id of this entry.
  - **`SettingView.perAccount?: boolean`**
  - **New `FromWebview` members:**
    - `{ type: 'addAccount'; agentId: string; name: string }`, where `agentId` is the type id;
    - `{ type: 'removeAccount'; agentId: string }`;
    - `{ type: 'setAccountsEnabled'; agentId: string; enabled: boolean }`.

- [ ] **Step 1: Write the failing tests**
  - **`controlPage.test.ts`:**
    - `it('lists an account after its type, with only its own settings')`: the state's `agents` ids are `['base', 'base-work']`. `base-work` has `accountOf: 'base'`, `accountName: 'Work'`, a `vendor` ending `· Work`, and only `perAccount` settings. `base` has `accountsEnabled: true`.
    - `it('runs addAccount and shows a refused name as the card error')`: on a refused name, `agents.find(a => a.id === 'base').error` holds the message.
    - `it('runs removeAccount and setAccountsEnabled')`.
  - **`sidebarRender.test.ts`:**
    - `it('draws accounts as rows inside their type card')`: one `<section class="card" data-agent="base">` containing rows for `Default` and `Work`, each with `data-action="setEnabled"` for its own id. The head toggle has `data-action="setAccountsEnabled"`. There is no second `section.card` for `base-work`.
    - `it('keeps the add and remove controls behind the gear')`: with settings closed, no `data-action="addAccount"` or `removeAccount`. With them open: shared settings, a "Per account" heading with `authPreference` for `base` and `base-work`, **Remove account** only for `base-work`, and a name input with **Add**.
    - `it('asks once more before removing an account')`: the first click renders `data-action="confirmRemoveAccount"`, a page-local state like `keyEntry`. Only that button sends `removeAccount`.
    - `it('draws a card without account support as today')`: an entry without `accountsEnabled` renders exactly as before, so the existing snapshots stay green.
  - `it('warns past ten accounts')`: with eleven extra accounts the open panel shows a note containing "runs its own processes". With ten or fewer accounts it doesn't.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/controlPage.test.ts test/unit/sidebarRender.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**
  - **`buildCard`:** fills the new fields from `ControlSurface`. `vendor` is `adapter.vendor`.
  - **`renderCards`:**
    - groups entries by `accountOf`;
    - an extra account's entry never renders as its own card;
    - extra accounts never appear in **+ Add agent**;
    - an account row reuses `renderAccount` and `renderUsage` for that entry;
    - add-account errors show on the type card;
    - the name input uses `data-account-name` and keeps its draft across redraws, like `keyDrafts`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/controlPage.test.ts test/unit/sidebarRender.test.ts test/unit/modelsPage.test.ts test/unit/serverPage.test.ts test/unit/noAgentBranching.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** `feat: show accounts inside their agent's card`

### Task 6: Picker groups per account in the VS Code window

**Files:**
- Modify: `src/sidebar/agentChanges.ts` (`offeredIn`, facts include the type's `accountsEnabled`)
- Modify: `src/hosts/vscode/serverProvider.ts` (`isOffered` dep)
- Modify: `src/hosts/vscode/applyNames.ts` (`syncAccountVendors`)
- Modify: `src/hosts/vscode/syncModels.ts` (`agents` entries carry `vendor`)
- Modify: `src/extension.ts`
- Test: `test/unit/agentChanges.test.ts`, `test/unit/serverProvider.test.ts`, `test/unit/applyNames.test.ts`, `test/unit/syncModels.test.ts`, `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `AgentCardState.accountOf`, `accountsEnabled`, `vendor` (Task 5); `readAccounts`, `accountVendor`, `accountsKey` (Task 1).
- Produces:
  - `offeredIn(state: ControlState, agentId: string): boolean`: the entry exists, its install is `installed`, `enabled` is true, and its type entry's `accountsEnabled !== false`.
  - `ServerProviderDeps.isOffered?: () => boolean | undefined`: `false` makes `provideLanguageModelChatInformation` return `[]` and forget the `offered` cache; `undefined` keeps today's path.
  - `syncAccountVendors(options: { packageJson: string; vendors: ReadonlyArray<{ vendor: string; displayName: string }>; baseVendors: ReadonlySet<string> }): boolean`. It keeps the base vendors' entries and their current `displayName`s, replaces every other entry with `vendors`, and returns whether the file changed. Indentation, EOL and BOM handling are the same as `writeVendorNames`.
  - `SyncModelsDeps.agents: ReadonlyArray<{ id: string; displayName: string; vendor: string }>`

- [ ] **Step 1: Write the failing tests**
  - **`agentChanges.test.ts`:**
    - `it('reports an account when its type is switched off')`: flipping the type's `accountsEnabled` lists both the type and `base-work`.
    - `it('offers an account only when it and its type are on and installed')`.
  - **`serverProvider.test.ts`:**
    - `it('offers nothing for a switched-off account, even with a saved list')`.
    - `it('offers the saved list while the state is unknown')`: `isOffered` returns `undefined`.
  - **`applyNames.test.ts`:**
    - `it('adds and removes account vendors and keeps base names')`: a manifest with a renamed `Claude Agent` heading plus a stale `Claude Agent · Old` becomes base entries (rename kept) plus `Claude Agent · Work`, and returns `true`. A second call returns `false`.
  - **`syncModels.test.ts`:**
    - `it('writes one CLI provider per account')`: wires `owned_by: 'claude-work'` become provider `Claude Agent · Work`.
  - **`extension.test.ts`**, with `vscode-mock` and a temp store root holding `config.json` accounts:
    - `it('registers a provider for each stored account')`: `registerLanguageModelChatProvider` is called with `Claude Agent · Work`.
    - `it('activation adds missing account vendors and asks for a reload')`: in Production mode with a package.json missing the vendor, the file gains it and `showInformationMessage` is offered `Reload Window`. In Development mode the file is untouched.
    - `it('a failed provider registration is logged, not thrown')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/agentChanges.test.ts test/unit/serverProvider.test.ts test/unit/applyNames.test.ts test/unit/syncModels.test.ts test/unit/extension.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement in `extension.ts`**
  - **Activation:**
    - read `loadConfig(root)`;
    - for every registry agent, register its provider as today;
    - for each `readAccounts(config, agent.id)` (Windows only), register a `ServerProvider` with `agentId = record.id` and `vendor = accountVendor(vendorOf(agent.id), record.name)`, inside try/catch.
  - **On relay state:**
    - recompute the vendor list from `state.agents` entries with `accountOf`;
    - if `syncAccountVendors` changed the installed `package.json`, show "Reload the window to update the account groups in the model picker." with **Reload Window**;
    - register providers for new accounts as above.
  - **`isOffered`:** each provider gets `() => drawn ? offeredIn(drawn, id) : undefined`.
  - **`acpHub.syncModels`:** passes registry agents plus accounts, each with `vendor`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit`
Expected: PASS

- [ ] **Step 5: Commit** `feat: a model-picker group per account`

### Task 7: Docs, full check and VSIX

**Files:**
- Modify: `README.md` (an "Accounts" section: add from ⚙, Windows only, reload prompt, model ids `claude-work/...`, removal deletes login and chats, Google not supported)
- Modify: `docs/copilot-cli-gateway.md` (account model ids and providers)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full gate**

Run: `npm run typecheck; npm run lint; npx vitest run; npm run generate:check`
Expected: all pass, and `generate:check` reports the repository `package.json` unchanged.

- [ ] **Step 3: Package and try it**

Run: `npx --yes @vscode/vsce package -o acp-hub-for-copilot-1.0.1-accounts.vsix`
Expected: `DONE Packaged`.

Then install it, add a Claude account named `Work`, and check:
- the reload prompt appears;
- the picker shows a `Claude Agent · Work` group after the reload;
- switching Work off hides the group without a reload;
- removing Work deletes `%USERPROFILE%\.acp-hub\agents\claude-work`.

- [ ] **Step 4: Commit** `docs: multiple accounts`
