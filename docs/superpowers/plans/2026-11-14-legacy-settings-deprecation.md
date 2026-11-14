# Legacy Settings Deprecation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `acpHub.agents.*` / `acpHub.resume.*` settings a 0.0.6 user still has in `settings.json` show as deprecated with a note saying where their value lives now, and say so once in the log.

**Architecture:** The window contributes 25 hand-written deprecated properties to `package.json`, which `applyRegistry` must learn to leave alone (it currently deletes every `acpHub.agents.*` key it finds). The one-time settings migration gains a single log line naming the legacy keys it saw.

**Tech Stack:** TypeScript, VS Code extension manifest, Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-14-legacy-settings-deprecation-design.md`

## Global Constraints

- Deprecated entries carry `type` and `deprecationMessage`, and **no `default`**.
- The migration keeps reading `globalValue` only; workspace-scoped values are out of scope.
- Nothing is deleted from a user's `settings.json`.
- `npm run generate:check` must print `package.json is up to date.`
- Commit subjects follow the repo's style: `type(scope): sentence`, plus the `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer.

## Review Focus

- A user whose only legacy key is `acpHub.agents.google.command` still learns what happened from the manifest deprecation (`DROPPED`), because the log line names only the keys the hub now reads from its store — the test for that stays green (Tasks 2 and 3).
- A user with more than five legacy settings gets one line naming five plus `and N more`, never a wall of text (Task 3).
- A user who saved nothing gets no line at all (Task 3).
- A stale generated key for an agent that no longer exists (`acpHub.agents.removed.enabled`) is still stripped by `generate`, not kept as if hand-written (Task 1).
- A deprecated entry never supplies a value: no `default` sneaks in (Task 2).

---

### Task 1: Let the generator keep hand-written deprecated entries

**Files:**
- Modify: `src/core/vendors.ts:44-62`
- Test: `test/unit/vendors.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyRegistry(packageJson, registry)` keeps a property whose key starts with `acpHub.agents.` **only** when the property object has a string `deprecationMessage`. Everything else starting with that prefix is dropped as today.

- [ ] **Step 1: Write the failing test**

Add inside `describe('vendors')` in `test/unit/vendors.test.ts`:

```ts
it('keeps a setting the extension declares as deprecated, so an older version is explained rather than unknown', () => {
	const result = applyRegistry({ contributes: { configuration: { properties: {
		'acpHub.agents.claude.enabled': { type: 'boolean', deprecationMessage: 'Moved to the ACP Hub store.' },
		'acpHub.agents.claude.idleTimeoutSeconds': { type: 'number' },
	} } } }, small) as { contributes: { configuration: { properties: Record<string, unknown> } } };
	expect(Object.keys(result.contributes.configuration.properties)).toEqual(['acpHub.agents.claude.enabled']);
	expect(result.contributes.configuration.properties['acpHub.agents.claude.enabled'])
		.toEqual({ type: 'boolean', deprecationMessage: 'Moved to the ACP Hub store.' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/vendors.test.ts -t "declares as deprecated"`
Expected: FAIL — received `{}`, the entry was dropped.

- [ ] **Step 3: Add the condition to the filter**

In `applyRegistry`, the filter becomes, in place of the current one:

```ts
.filter(([key, value]) => !key.startsWith(AGENT_SETTING_PREFIX) || typeof (value as JsonObject).deprecationMessage === 'string')
```

Extend the function's doc comment with one sentence: a setting the extension declares as deprecated is hand-written and is kept; everything a previous version generated still goes.

- [ ] **Step 4: Run the whole vendors file**

Run: `npx vitest run test/unit/vendors.test.ts`
Expected: PASS, including the unchanged test *drops agent settings a previous version generated* — `acpHub.agents.removed.enabled` has no `deprecationMessage` and is still removed.

- [ ] **Step 5: Commit**

```bash
git add src/core/vendors.ts test/unit/vendors.test.ts
git commit -m "fix(settings): keep a deprecated setting the generator used to delete"
```

---

### Task 2: Declare the 25 legacy settings as deprecated

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`, after `acpHub.server.autoStart`)
- Test: `test/unit/vendors.test.ts`

**Interfaces:**
- Consumes: Task 1's generator rule.
- Produces: 25 properties whose key starts with `acpHub.` and whose value carries `type` + `deprecationMessage`, no `default`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/vendors.test.ts`, above `describe('vendors')`:

```ts
/** Exactly what the released 0.0.6 manifest contributed and 1.0.0 does not. */
const LEGACY_SETTINGS = [
	'acpHub.resume.transcriptDetail',
	'acpHub.resume.transcriptMaxCharacters',
	'acpHub.resume.transcriptMaxToolResultCharacters',
	'acpHub.agents.claude.enabled',
	'acpHub.agents.claude.idleTimeoutSeconds',
	'acpHub.agents.claude.idleShutdownMinutes',
	'acpHub.agents.claude.dumpRequests',
	'acpHub.agents.claude.authPreference',
	'acpHub.agents.claude.toolSearch',
	'acpHub.agents.claude.replaceSystemPrompt',
	'acpHub.agents.codex.enabled',
	'acpHub.agents.codex.idleTimeoutSeconds',
	'acpHub.agents.codex.idleShutdownMinutes',
	'acpHub.agents.codex.dumpRequests',
	'acpHub.agents.codex.authPreference',
	'acpHub.agents.codex.maxContextWindow',
	'acpHub.agents.codex.replaceSystemPrompt',
	'acpHub.agents.google.enabled',
	'acpHub.agents.google.idleTimeoutSeconds',
	'acpHub.agents.google.idleShutdownMinutes',
	'acpHub.agents.google.dumpRequests',
	'acpHub.agents.google.authPreference',
	'acpHub.agents.google.command',
	'acpHub.agents.google.args',
	'acpHub.agents.google.useAgentBuiltInTools',
];
```

and, inside `describe('vendors')`:

```ts
it('deprecates exactly the settings the released 0.0.6 contributed', () => {
	const properties = packageJson.contributes.configuration.properties as Record<string, Record<string, unknown>>;
	const deprecated = Object.entries(properties)
		.filter(([, value]) => typeof value.deprecationMessage === 'string')
		.map(([key]) => key)
		.sort();
	expect(deprecated).toEqual([...LEGACY_SETTINGS].sort());
});

it('gives every deprecated setting a type and no default', () => {
	const properties = packageJson.contributes.configuration.properties as Record<string, Record<string, unknown>>;
	for (const key of LEGACY_SETTINGS) {
		expect(properties[key].type, key).toBeDefined();
		expect(properties[key].default, key).toBeUndefined();
		expect(properties[key].deprecationMessage, key).toContain('ACP Hub');
	}
});
```

Then update the existing test *contributes only the settings the extension itself reads*: its first assertion is replaced by

```ts
expect(Object.keys(properties).sort()).toEqual([...LEGACY_SETTINGS, 'acpHub.server.autoStart', 'acpHub.server.detached', 'acpHub.server.idleTimeoutMinutes'].sort());
```

The three `toMatchObject` assertions and the `order` assertion stay as they are.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/vendors.test.ts`
Expected: FAIL — `deprecated` is `[]`, and the key list has only the three server settings.

- [ ] **Step 3: Add the 25 properties to `package.json`**

Insert after the `acpHub.server.autoStart` property, keeping the file's tab indentation. Use these two messages verbatim:

- `MOVED`: `"Moved to the ACP Hub store. The value you saved was carried into config.json the first time 1.0.0 ran; change it in the ACP Hub sidebar or the control page."`
- `DROPPED`: `"No longer used. The Google agent always runs the Antigravity CLI that ACP Hub installs; this value is ignored."`

Types: `resume.transcriptDetail` string; `resume.transcriptMaxCharacters` number; `resume.transcriptMaxToolResultCharacters` number; every `enabled` boolean; `idleTimeoutSeconds` number; `idleShutdownMinutes` number; `dumpRequests` boolean; `authPreference` string; `toolSearch` string; `replaceSystemPrompt` boolean; `maxContextWindow` boolean; `google.command` string; `google.args` `"type": "array", "items": { "type": "string" }`; `google.useAgentBuiltInTools` boolean. `MOVED` for all but `google.command`, `google.args`, `google.useAgentBuiltInTools`, which use `DROPPED`.

- [ ] **Step 4: Run the tests and the generator check**

Run: `npx vitest run test/unit/vendors.test.ts` — Expected: PASS.
Run: `npm run generate:check` — Expected: `package.json is up to date.` If it says otherwise, run `npm run generate` and diff: the only change must be none (the generator should have kept every deprecated entry).

- [ ] **Step 5: Commit**

```bash
git add package.json test/unit/vendors.test.ts
git commit -m "feat(settings): show the settings 0.0.6 contributed as deprecated"
```

---

### Task 3: Name the legacy settings once, in the log

**Files:**
- Modify: `src/core/settingsMigration.ts` (`migrateSettingsOnce`, the section loop and the lines before `await options.state.update(SETTINGS_MIGRATION_MARKER, true)`)
- Test: `test/unit/settingsMigration.test.ts`

**Interfaces:**
- Consumes: the existing `MigrateSettingsOptions`.
- Produces: no signature change. One extra `log` call per successful run, wrapping to one line.

- [ ] **Step 1: Write the failing tests**

Add to `describe('the settings migration')` in `test/unit/settingsMigration.test.ts`:

```ts
it('names the settings left in settings.json, which the hub reads from its own store now', async () => {
	const root = tempRoot();
	const store = createFileStore(root);
	const lines: string[] = [];

	await migrateSettingsOnce({
		saved: savedFrom({ 'agents.claude.toolSearch': 'off', 'resume.transcriptDetail': 'brief', 'agents.google.command': 'agy' }),
		config: new FileConfig(configFileOf(root)),
		agents,
		state: store.state,
		log: message => { lines.push(message); },
	});

	const line = lines.find(text => text.includes('settings.json still sets'));
	expect(line).toBeDefined();
	expect(line).toContain('2 ACP Hub settings');
	expect(line).toContain('acpHub.agents.claude.toolSearch');
	expect(line).toContain('acpHub.resume.transcriptDetail');
	expect(line).toContain('ACP Hub sidebar');
});

it('names five settings and counts the rest', async () => {
	const root = tempRoot();
	const store = createFileStore(root);
	const lines: string[] = [];

	await migrateSettingsOnce({
		saved: savedFrom({
			'agents.claude.enabled': true,
			'agents.claude.idleTimeoutSeconds': 60,
			'agents.claude.toolSearch': 'off',
			'agents.codex.enabled': true,
			'agents.codex.idleTimeoutSeconds': 60,
			'resume.transcriptDetail': 'brief',
		}),
		config: new FileConfig(configFileOf(root)),
		agents,
		state: store.state,
		log: message => { lines.push(message); },
	});

	const line = lines.find(text => text.includes('settings.json still sets'));
	expect(line).toContain('6 ACP Hub settings');
	expect(line).toContain('and 1 more');
});

it('says nothing about settings.json when the user saved nothing', async () => {
	const root = tempRoot();
	const store = createFileStore(root);
	const lines: string[] = [];

	await migrateSettingsOnce({ saved: () => undefined, config: new FileConfig(configFileOf(root)), agents, state: store.state, log: message => { lines.push(message); } });

	expect(lines.join('\n')).not.toContain('settings.json');
});
```

Note: `agents` in this file has `claude: ['idleTimeoutSeconds', 'toolSearch']` and `codex: ['idleTimeoutSeconds']`, so five per-agent keys plus `resume.*` reach the line; `google.command` is not a section the migration looks at.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/settingsMigration.test.ts`
Expected: FAIL — `line` is `undefined` in the first two tests.

- [ ] **Step 3: Collect and log**

Inside the loop, record `acpHub.<section>` for every section whose saved value is neither `undefined` nor `null`, before the `config.get` check. After the existing `if (failed > 0) return true;` and after the "Carried N settings" line, log once when the list is not empty: the count, up to five names joined by `, `, then `, and N more` when there are more, then `; set it/them from the ACP Hub sidebar.`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/settingsMigration.test.ts`
Expected: PASS, the four existing tests included.

- [ ] **Step 5: Commit**

```bash
git add src/core/settingsMigration.ts test/unit/settingsMigration.test.ts
git commit -m "feat(settings): say once which settings.json entries the hub no longer reads"
```

---

### Task 4: Tell the user in the changelog and the README

**Files:**
- Modify: `CHANGELOG.md` (the "Upgrading keeps the agents' settings." bullet)
- Modify: `README.md:56` (the "**Settings.**" paragraph)

**Interfaces:** none.

- [ ] **Step 1: Extend the changelog bullet**

Append to that bullet: only values saved in the user's own settings are carried (a value saved in a workspace's `.vscode/settings.json` is not, since the hub's `config.json` is one file for the machine), and the settings the extension no longer contributes now show as deprecated in `settings.json`, with a note saying where they went — the first run after the upgrade names them in the **ACP Hub** log.

- [ ] **Step 2: Extend the README paragraph**

After "…and they are ignored in `settings.json` from then on.", add that only user-settings values are copied, and that the old keys stay in `settings.json` marked deprecated, pointing at the ACP Hub page.

- [ ] **Step 3: Run the docs gate and the full suite**

Run: `npm run typecheck; npm run lint; npm test`
Expected: all pass; 1172 + 3 new tests.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: describe the deprecated settings an upgrade leaves in settings.json"
```
