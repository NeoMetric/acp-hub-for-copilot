# Models Refresh + `ACP Hub: Sync Models` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Models page's `Sync` into a client-neutral `Refresh`, and move the Copilot-specific file writes into a new VS Code command, `ACP Hub: Sync Models`.

**Architecture:** The HTTP server keeps only the model catalog and a `POST /v1/models/refresh` route that nobody but a client calls. The Copilot CLI `providers.json` writer and the extension-manifest writer move to `src/hosts/vscode/`, driven by `syncModels()` from `extension.ts`. Saving a name on the page only stores the override.

**Tech Stack:** TypeScript, VS Code extension API, Node `fs`, Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-10-sync-models-command-design.md`

## Global Constraints

- `src/hosts/http/**` must not import `vscode`.
- Only display names change: agent ids, `vendor` ids, wire ids (`<agent>/<model>`), efforts and context windows stay as they are.
- `ServerEndpoint.baseUrl` is `http://127.0.0.1:<port>` with no `/v1`; every `/v1/...` route is appended to it.
- A sync writes entries it wrote before (`server.cliProviders`) and the legacy `acp-hub` provider away; any other entry in `providers.json` is kept.
- A file that is not a JSON object is refused and left byte-for-byte as it was.
- Each target reports its own failure; a failure in one does not stop the other.
- The working tree has unrelated uncommitted changes: `git add` only the paths a task names.
- Commands: `npm test -- <file>` for one test file, `npm run typecheck`, `npm run lint`.

## Review Focus

- The server is stopped or answers with an error when the command runs → a warning naming the reason, and neither file is touched.
- `providers.json` holds text that is not a JSON object → refused and left as it was, `package.json` still updated, both outcomes reported.
- `package.json` cannot be read or written → `providers.json` is still written and its success reported.
- No agent offers any model → `providers.json` is left as it was and that is reported; an empty provider list is never written.
- Two models that share a name after the slash-strip → distinct ids, the later one suffixed `-2`, and a name containing `/` never reaches an id with a slash (the existing `writeCliProviders` case covers the writer; Task 4 repeats it end to end).

---

### Task 1: The page's Sync becomes Refresh, and the surface stops writing files

**Files:**
- Modify: `src/ui/messages.ts`
- Modify: `src/ui/render.ts:222-250`
- Modify: `src/ui/page.ts:21-24,54,113-115`
- Modify: `src/ui/controlPage.ts:68-72,109-125,210-235`
- Modify: `src/ui/transport.ts:27`
- Modify: `src/hosts/http/modelsSurface.ts` (whole file)
- Modify: `src/hosts/http/server.ts:104-115,197-213` and the `copilotProvidersFile`/`manifestPath` helpers
- Test: `test/unit/modelsPage.test.ts`, `test/unit/controlPage.test.ts`, `test/unit/modelsSurface.test.ts`, `test/unit/controlTransport.test.ts`
- Left for Task 3: `src/hosts/http/applyNames.ts` stops being imported here and moves there; its test keeps passing until then.

**Interfaces:**
- Consumes: `ModelNames` (`src/engine/models/modelNames.ts`), `ModelEntry`, `StateStore`.
- Produces:
  - `ModelsSurface.refresh(): Promise<string>` replacing `sync()`.
  - `ControlState.refreshing?: boolean` replacing `syncing`.
  - `FromWebview` member `{ type: 'refreshModels' }` replacing `{ type: 'syncModels' }`.
  - `ModelsSurfaceDeps` = `{ adapters, usable, names, source: { savedOf, refresh } }` — no `state`, `token`, `baseUrl`, `providersFile`, `packageJson`.
  - `HttpServerOptions` without `providersFile` and `packageJson`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/modelsSurface.test.ts`, delete the temp-file setup, the `manifest` option and every assertion about `providersFile`/`packageJson`; build the surface with the four remaining deps. Add:

```ts
it('refreshes the agents it can use, and names them', async () => {
	const { surface, refresh } = setup({ usable: id => id === 'claude' });

	expect(await surface.refresh()).toBe('Refreshed claude.');

	expect(refresh).toHaveBeenCalledTimes(1);
});

it('says so when no agent answered', async () => {
	const { surface } = setup({ usable: () => false });

	expect(await surface.refresh()).toBe('No installed agent answered with models; the saved lists are unchanged.');
});

it('saves a name without writing any file', async () => {
	const { surface } = setup();

	expect(await surface.setProviderName('claude', 'Work Claude')).toBe(SAVED_NOTICE);
});

it('keeps a refused name as the notice', async () => {
	const { surface } = setup();
	await surface.setProviderName('claude', 'Codex Agent');

	expect(await surface.setProviderName('codex', 'Work Claude')).toContain('Another agent is already shown as');
});
```

with `export const SAVED_NOTICE` imported from the module (Step 3 defines it as `` `Saved. Run "ACP Hub: Sync Models" in VS Code to update the model pickers.` ``).

In `test/unit/controlPage.test.ts`, replace `sync: vi.fn(async () => 'synced')` with `refresh: vi.fn(async () => 'refreshed')`, the three `{ type: 'syncModels' }` sends with `{ type: 'refreshModels' }`, `models.sync` with `models.refresh`, `notice: 'synced'` with `'refreshed'`, and every `syncing` with `refreshing`.

In `test/unit/modelsPage.test.ts`, replace `data-action="syncModels"` with `data-action="refreshModels"`, the title case `Sync models` copy with `Refresh`, and `{ syncing: true }` with `{ refreshing: true }`; the empty card's note becomes `No models yet; press Refresh to load them.`

In `test/unit/controlTransport.test.ts:210`, `syncing: true` becomes `refreshing: true`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- test/unit/modelsSurface.test.ts test/unit/controlPage.test.ts test/unit/modelsPage.test.ts test/unit/controlTransport.test.ts`
Expected: FAIL — `surface.refresh is not a function`, unknown action type, unmatched strings.

- [ ] **Step 3: Rewrite the surface and the contract**

`src/ui/messages.ts`: `sync(): Promise<string>` becomes `refresh(): Promise<string>`; `syncing?: boolean` becomes `refreshing?: boolean`; the `FromWebview` member becomes `| { type: 'refreshModels' }`.

`src/hosts/http/modelsSurface.ts`:

```ts
export const SAVED_NOTICE = 'Saved. Run "ACP Hub: Sync Models" in VS Code to update the model pickers.';

export interface ModelsSurfaceDeps {
	readonly adapters: readonly AgentAdapter[];
	readonly usable(adapter: AgentAdapter): Promise<boolean>;
	readonly names: ModelNames;
	readonly source: {
		savedOf(agentId: string): ModelEntry[];
		refresh(adapter: AgentAdapter): Promise<ModelEntry[]>;
	};
}
```

`setProviderName` and `setModelName` await the `names` call, turn a `NameError` into its message, and otherwise answer `SAVED_NOTICE`. `refresh()` loops the adapters `usable` allows, calls `source.refresh` on each inside `try`/`catch`, collects the ids whose list is non-empty, and answers `` refreshed.length > 0 ? `Refreshed ${refreshed.join(', ')}.` : 'No installed agent answered with models; the saved lists are unchanged.' ``. Drop `apply`, `change`, `defaultProviders` stays, and every import of `applyNames`, `vendorOf`, `StateStore` and the two file paths.

`src/hosts/http/server.ts`: hoist the `usable` closure out of the `createModelsSurface` call, drop `providersFile`, `packageJson`, `copilotProvidersFile()` and `manifestPath()` from the options and the file.

`src/ui/render.ts`: `renderModels(models, notice, { refreshing, editing })`, the button `<button data-action="refreshModels"${refreshing ? ' disabled' : ''}>Refresh</button>`, the busy line `Reading the models of the agents…`, and the empty note `No models yet; press Refresh to load them.`

`src/ui/page.ts`: the `refreshing` variable, the `refreshModels` action sending `{ type: 'refreshModels' }`, and `state.refreshing === true`.
`src/ui/controlPage.ts`: the `refreshing` field, `action.type === 'refreshModels'` in the models branch, and `this.models.refresh()` where `sync()` was called.
`src/ui/transport.ts`: `refreshing: message.refreshing`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test -- test/unit/modelsSurface.test.ts test/unit/controlPage.test.ts test/unit/modelsPage.test.ts test/unit/controlTransport.test.ts test/unit/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`, then `npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui src/hosts/http test/unit/modelsSurface.test.ts test/unit/controlPage.test.ts test/unit/modelsPage.test.ts test/unit/controlTransport.test.ts
git commit -m "refactor(server): the Models page refreshes, and writes no Copilot files"
```

---

### Task 2: A client-neutral `POST /v1/models/refresh`

**Files:**
- Modify: `src/hosts/http/wire.ts`
- Modify: `src/hosts/http/server.ts` (route, `ModelCatalog`, the known-route switch)
- Test: `test/unit/server.test.ts`

**Interfaces:**
- Consumes: the `usable` closure hoisted in Task 1, `ModelCatalog.refresh(adapter)`.
- Produces:
  - `export const MODELS_REFRESH_ROUTE = '/v1/models/refresh'` in `wire.ts`.
  - `export interface ModelsRefreshWire { refreshed: string[] }`.
  - `ModelCatalog.refreshAll(usable: (adapter: AgentAdapter) => Promise<boolean>): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

In `test/unit/server.test.ts`, beside the model-list tests, with the `post` helper the file already has:

```ts
it('re-reads the models on request and names the agents that answered', async () => {
	const response = await post(`${url}/v1/models/refresh`);

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ refreshed: ['mock'] });
});

it('refuses the refresh route for a method it does not serve', async () => {
	expect((await fetch(`${url}/v1/models/refresh`)).status).toBe(405);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/unit/server.test.ts`
Expected: FAIL — 404 for the new route.

- [ ] **Step 3: Add the constant, the catalog method and the route**

`wire.ts`, after `WARM_ROUTE`:

```ts
/** `POST /v1/models/refresh`: re-reads every usable agent's models; answers the agent ids that gave a list. */
export const MODELS_REFRESH_ROUTE = '/v1/models/refresh';

export interface ModelsRefreshWire {
	refreshed: string[];
}
```

`ModelCatalog`, next to `refresh`:

```ts
/** Re-reads every agent's models that `usable` allows, and answers the agent ids that gave a list. */
async refreshAll(usable: (adapter: AgentAdapter) => Promise<boolean>): Promise<string[]> {
	const refreshed: string[] = [];
	for (const adapter of this.composition.adapters) {
		if (await usable(adapter) && (await this.refresh(adapter)).length > 0) {
			refreshed.push(adapter.id);
		}
	}
	return refreshed;
}
```

In `handle`, after the `/v1/models` branch: `if (route === MODELS_REFRESH_ROUTE && method === 'POST')` writes `200` with `{ refreshed: await catalog.refreshAll(usable) }` as JSON, and add `MODELS_REFRESH_ROUTE` to the route switch that answers `405` for a served route with the wrong method.

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/unit/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/http/wire.ts src/hosts/http/server.ts test/unit/server.test.ts
git commit -m "feat(server): POST /v1/models/refresh re-reads the agents' models for any client"
```

---

### Task 3: The Copilot file writers move to the VS Code host

**Files:**
- Create: `src/hosts/vscode/applyNames.ts` (moved from `src/hosts/http/applyNames.ts`)
- Delete: `src/hosts/http/applyNames.ts`
- Test: `test/unit/applyNames.test.ts` (import path, plus the new return value)

**Interfaces:**
- Produces:
  - `CLI_PROVIDERS_KEY = 'server.cliProviders'`
  - `copilotProvidersFile(): string` — `COPILOT_PROVIDERS_CONFIG` when set, else `path.join(os.homedir(), '.copilot', 'providers.json')`
  - `CliProvider`, `writeCliProviders(options): { written: string[] }` — unchanged body
  - `writeVendorNames(options): boolean` — now answers whether the manifest changed

- [ ] **Step 1: Write the failing test**

In `test/unit/applyNames.test.ts`, change the import to `../../src/hosts/vscode/applyNames` and add:

```ts
it('answers whether the manifest changed, so the caller knows a reload is due', () => {
	const file = tempFile('package.json', JSON.stringify({ contributes: { languageModelChatProviders: [{ vendor: 'Claude Agent', displayName: 'Claude Agent' }] } }));

	expect(writeVendorNames({ packageJson: file, names: { 'Claude Agent': 'Work Claude' } })).toBe(true);
	expect(writeVendorNames({ packageJson: file, names: { 'Claude Agent': 'Work Claude' } })).toBe(false);
});

it('reads the CLI provider file from the environment, and the home folder otherwise', () => {
	expect(copilotProvidersFile()).toBe(path.join(os.homedir(), '.copilot', 'providers.json'));
	process.env.COPILOT_PROVIDERS_CONFIG = 'C:\\tmp\\mine.json';
	expect(copilotProvidersFile()).toBe('C:\\tmp\\mine.json');
	delete process.env.COPILOT_PROVIDERS_CONFIG;
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/unit/applyNames.test.ts`
Expected: FAIL — cannot resolve `src/hosts/vscode/applyNames`.

- [ ] **Step 3: Move the file and widen the return value**

Move the file with `git mv src/hosts/http/applyNames.ts src/hosts/vscode/applyNames.ts`; keep the bodies; change `writeVendorNames` to return `false` when `changed` is false and `true` after the write; add `CLI_PROVIDERS_KEY` and `copilotProvidersFile()` with `node:os` imported.

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/unit/applyNames.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/vscode/applyNames.ts src/hosts/http/applyNames.ts test/unit/applyNames.test.ts
git commit -m "refactor(vscode): the Copilot file writers live in the extension host"
```

---

### Task 4: `syncModels()` writes both targets

**Files:**
- Modify: `src/hosts/vscode/serverClient.ts` (a `refreshModels` call)
- Create: `src/hosts/vscode/syncModels.ts`
- Test: `test/unit/syncModels.test.ts`

**Interfaces:**
- Consumes: `listModels(endpoint)` and `ServerChatError` from `./serverClient`; `writeCliProviders`, `writeVendorNames`, `CLI_PROVIDERS_KEY`, `copilotProvidersFile`, `CliProvider` from `./applyNames`; `ModelNames`; `vendorOf`.
- Produces:
  - `refreshModels(endpoint: ServerEndpoint, signal?: AbortSignal): Promise<string[]>`
  - `syncModels(deps: SyncModelsDeps): Promise<SyncOutcome>` with
    ```ts
    export interface SyncModelsDeps {
        readonly endpoint: ServerEndpoint;
        readonly agents: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
        readonly names: ModelNames;
        readonly state: StateStore;
        readonly packageJson: string;
        readonly providersFile: string;
    }
    export interface SyncOutcome {
        readonly refreshed: string[];
        readonly providers: number;
        readonly models: number;
        readonly problems: string[];
        readonly reloadNeeded: boolean;
    }
    ```

- [ ] **Step 1: Write the failing tests**

`test/unit/syncModels.test.ts`, stubbing `globalThis.fetch` with `vi.stubGlobal`:

```ts
it('writes one provider per agent the server published, with the names the user chose', async () => {
	stubServer({ 'Work Claude': ['Fast one'] });

	const outcome = await run();

	const config = read(providersFile);
	expect(config.providers).toEqual([{ name: 'Work Claude', type: 'openai', baseUrl: 'http://127.0.0.1:8791/v1', bearerToken: 'secret' }]);
	expect(config.models).toEqual([{ id: 'Fast-one', provider: 'Work Claude', wireModel: 'claude/sonnet' }]);
	expect(outcome).toMatchObject({ providers: 1, models: 1, problems: [], reloadNeeded: true });
});

it('keeps the entries it did not write', async () => {
	fs.writeFileSync(providersFile, JSON.stringify({ providers: [{ name: 'github' }, { name: 'acp-hub' }], models: [{ id: 'keep', provider: 'github' }, { id: 'drop', provider: 'acp-hub' }] }));

	await run();

	expect(read(providersFile).providers.map((entry: any) => entry.name)).toEqual(['github', 'Work Claude']);
	expect(read(providersFile).models.map((entry: any) => entry.id)).toContain('keep');
});

it('gives two models that show the same name distinct ids', async () => {
	stubServer({ 'Work Claude': ['Fast one', 'Fast one'] });

	await run();

	expect(read(providersFile).models.map((entry: any) => entry.id)).toEqual(['Fast-one', 'Fast-one-2']);
});

it('leaves providers.json alone when no agent offers a model, and says so', async () => {
	fs.writeFileSync(providersFile, JSON.stringify({ providers: [{ name: 'mine' }], models: [] }));
	stubServer({});

	const outcome = await run();

	expect(read(providersFile).providers).toEqual([{ name: 'mine' }]);
	expect(outcome.problems).toEqual(['No agent offered a model, so providers.json was left as it was.']);
});

it('reports a providers.json it cannot parse and still writes the manifest', async () => {
	fs.writeFileSync(providersFile, 'not json');
	stubServer({ 'Work Claude': ['Fast one'] });

	const outcome = await run();

	expect(outcome.problems[0]).toContain('is not a JSON object');
	expect(read(packageJson).contributes.languageModelChatProviders[0].displayName).toBe('Work Claude');
});

it('reports a manifest it cannot write and still writes providers.json', async () => {
	stubServer({ 'Work Claude': ['Fast one'] });

	const outcome = await run({ packageJson: path.join(folder, 'missing', 'package.json') });

	expect(outcome.problems[0]).toContain('VS Code: could not update');
	expect(read(providersFile).providers).toHaveLength(1);
});
```

`stubServer` answers `POST /v1/models/refresh` with `{ refreshed: ['claude'] }` and `GET /v1/models` with one `acp`-bearing entry per name, `owned_by: 'claude'`, `id: 'claude/<value>'`; `run(overrides)` builds the deps over a temp `providers.json`/`package.json` with `ModelNames` over `server.modelNames` = `{ providers: { claude: 'Work Claude' }, models: { claude: { sonnet: 'Fast one' } } }`.

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/unit/syncModels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the client call and the sync**

`serverClient.ts`, beside `listModels`:

```ts
/** Asks the server to read the agents' models again, and answers the agent ids it refreshed. */
export async function refreshModels(endpoint: ServerEndpoint, signal?: AbortSignal): Promise<string[]> {
	const response = await send(endpoint, MODELS_REFRESH_ROUTE, { method: 'POST', signal }, 'the model refresh');
	const value = parseJson(await response.text()) as { refreshed?: unknown } | undefined;
	return Array.isArray(value?.refreshed) ? value.refreshed.filter((id): id is string => typeof id === 'string') : [];
}
```

`syncModels.ts`:

```ts
export async function syncModels(deps: SyncModelsDeps): Promise<SyncOutcome> {
	const problems: string[] = [];
	let refreshed: string[] = [];
	try {
		refreshed = await refreshModels(deps.endpoint);
	} catch (error) {
		problems.push(`The agents' models could not be read again: ${messageOf(error)}`);
	}
	const wires = await listModels(deps.endpoint);
	const providers: CliProvider[] = [];
	for (const agent of deps.agents) {
		const models = wires.filter(wire => wire.owned_by === agent.id && wire.acp !== undefined);
		if (models.length > 0) {
			providers.push({
				name: deps.names.providerName(agent.id, agent.displayName),
				models: models.map(wire => ({ name: wire.acp!.name, wireModel: wire.id })),
			});
		}
	}
	let written: string[] = [];
	if (providers.length === 0) {
		problems.push('No agent offered a model, so providers.json was left as it was.');
	} else {
		try {
			const result = writeCliProviders({
				file: deps.providersFile,
				baseUrl: `${deps.endpoint.baseUrl}/v1`,
				token: deps.endpoint.token,
				providers,
				previous: deps.state.get<string[]>(CLI_PROVIDERS_KEY) ?? [],
			});
			written = result.written;
			await deps.state.update(CLI_PROVIDERS_KEY, written);
		} catch (error) {
			problems.push(`Copilot CLI: ${messageOf(error)}`);
		}
	}
	let reloadNeeded = false;
	try {
		reloadNeeded = writeVendorNames({
			packageJson: deps.packageJson,
			names: Object.fromEntries(deps.agents.map(agent => [vendorOf(agent.id), deps.names.providerName(agent.id, agent.displayName)])),
		});
	} catch (error) {
		problems.push(`VS Code: could not update ${deps.packageJson}: ${messageOf(error)}`);
	}
	return {
		refreshed,
		providers: written.length,
		models: providers.reduce((total, provider) => total + provider.models.length, 0),
		problems,
		reloadNeeded,
	};
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/unit/syncModels.test.ts test/unit/serverClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/vscode/serverClient.ts src/hosts/vscode/syncModels.ts test/unit/syncModels.test.ts
git commit -m "feat(vscode): syncModels writes providers.json and the provider headings"
```

---

### Task 5: The `ACP Hub: Sync Models` command

**Files:**
- Modify: `package.json:58-83`
- Modify: `src/extension.ts`
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `syncModels` from `./hosts/vscode/syncModels`, `ModelNames`, `copilotProvidersFile`, the existing `binding` and `providers` map.
- Produces: command id `acpHub.syncModels`, title `ACP Hub: Sync Models`.

- [ ] **Step 1: Write the failing test**

In `test/unit/extension.test.ts`, add `showInformationMessage` and `showErrorMessage` (`async (...args: unknown[]) => { mocks.messages.push(args); return undefined; }`) to the `vscode` mock with a `messages: [] as unknown[][]` bucket, and:

```ts
it('offers the sync command, and stops with a warning when the server is unavailable', async () => {
	activateOnce();
	mocks.linkReady = false;

	await mocks.commands.get('acpHub.syncModels')?.();

	expect(mocks.warnings.at(-1)?.[0]).toContain('not available');
	expect(mocks.messages).toEqual([]);
});

it('re-lists every provider after a sync', async () => {
	activateOnce();
	stubServerModels();

	await mocks.commands.get('acpHub.syncModels')?.();

	expect(mocks.refreshed).toEqual(['claude', 'codex', 'google']);
	expect(mocks.messages.at(-1)?.[0]).toContain('Synced');
});
```

The mock's `ServerLink.ensure()` gains a `mocks.linkReady` gate returning `{ kind: 'unavailable', reason: 'it is stopped' }` when false; `stubServerModels()` stubs `globalThis.fetch` for the refresh and model-list routes.

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/unit/extension.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'syncModels')`.

- [ ] **Step 3: Register the command**

`package.json` `contributes.commands`, after `acpHub.refreshUsage`:

```json
{ "command": "acpHub.syncModels", "title": "ACP Hub: Sync Models" },
```

`src/extension.ts`, inside the `context.subscriptions.push(...)` group:

```ts
vscode.commands.registerCommand('acpHub.syncModels', async () => {
	const state = await binding.ensure({ background: true });
	if (state.kind !== 'ready') {
		void vscode.window.showWarningMessage(`The ACP Hub server is not available (${state.reason}), so the model pickers were not synced.`);
		return;
	}
	try {
		const outcome = await syncModels({
			endpoint: state.endpoint,
			agents: REGISTRY.agents,
			names: new ModelNames(shared.store.state),
			state: shared.store.state,
			packageJson: path.join(extensionDir, 'package.json'),
			providersFile: copilotProvidersFile(),
		});
		for (const provider of providers.values()) {
			provider.refresh();
		}
		for (const problem of outcome.problems) {
			log(problem, 'warn');
		}
		const summary = `Synced ${outcome.models} model(s) of ${outcome.providers} agent(s) into the Copilot model pickers.`;
		if (outcome.problems.length > 0) {
			void vscode.window.showWarningMessage(`${summary} ${outcome.problems.join(' ')}`);
			return;
		}
		const answer = await vscode.window.showInformationMessage(
			outcome.reloadNeeded ? `${summary} Reload the window to see the provider names, and restart the Copilot CLI.` : `${summary} Restart the Copilot CLI to see them there.`,
			...(outcome.reloadNeeded ? ['Reload Window'] : []),
		);
		if (answer === 'Reload Window') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (error) {
		void vscode.window.showErrorMessage(`The model pickers were not synced: ${messageOf(error)}`);
	}
}),
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/unit/extension.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and the full suite**

Run: `npm run typecheck`, then `npm test`
Expected: clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add package.json src/extension.ts test/unit/extension.test.ts
git commit -m "feat(vscode): ACP Hub: Sync Models updates both Copilot model pickers"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md:36,56,72`
- Modify: `docs/copilot-cli-gateway.md:20-22`
- Modify: `CHANGELOG.md`

**Interfaces:** none.

- [ ] **Step 1: Update the README**

Line 36: the CLI section reads that **ACP Hub: Sync Models** (command palette) fetches the agents' current models and writes them, with the server's address and token, to `~/.copilot/providers.json` (or `COPILOT_PROVIDERS_CONFIG`); restart the CLI afterwards, and entries the extension did not write are kept.
Line 56: rename note says after a rename, run **ACP Hub: Sync Models** and reload the window for the provider headings.
Line 72: the Models view note ends with the page's **Refresh** button re-reading the agents' models.

- [ ] **Step 2: Update the gateway doc**

The `providers.json` bullet names **ACP Hub: Sync Models** as the writer, and says the server itself never writes it.

- [ ] **Step 3: Update the changelog**

Add an entry: the Models page's Sync became Refresh and writes nothing; the Copilot CLI file and the provider headings are now written by the **ACP Hub: Sync Models** command, so the server stays client-agnostic.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/copilot-cli-gateway.md CHANGELOG.md
git commit -m "docs: the Models page refreshes; ACP Hub: Sync Models syncs the pickers"
```
