# Legacy settings after the 1.0.0 upgrade

Short design. A small change: the code is one filter condition, one log line and
one block of `package.json`.

## What this is for

The 1.0.0 runtime reads its settings from `<root>/config.json`, and the window
contributes only `acpHub.server.*`. Nothing changes that. What it leaves behind
is an untidy upgrade:

- Every `acpHub.agents.*` and `acpHub.resume.*` entry a 0.0.6 user saved still
  sits in `settings.json`, is flagged by VS Code as an unknown setting, and
  silently does nothing when the user edits it.
- Nothing tells the user that the hub now keeps those values in its own store.

So the user who is most likely to look — the one who had customised an agent —
is the one who sees the most confusing state after the update.

## Goals

- A setting the extension no longer contributes is shown by VS Code as
  deprecated, with a message saying where its value lives now, instead of as
  unknown.
- The first activation after the upgrade logs one line naming the settings it
  found in `settings.json` and where they live now.
- `npm run generate` and `npm run generate:check` stay green and keep cleaning
  up settings that a previous version generated.

## Non-goals

- **Workspace-scoped values are not carried over.** Decision taken with the
  owner: the number of users who save `acpHub.*` in a workspace is small, and
  `config.json` is one file for the whole machine, so there is no honest place
  to put a per-workspace value. The migration keeps reading `globalValue` only.
  The changelog says so in one sentence.
- Deleting the old keys from `settings.json`. Destructive, irreversible, and it
  removes the user's route back to 0.0.6. If it is ever wanted, it is its own
  change, a release later (expand → migrate → verify → contract).
- Re-reading legacy keys at runtime. `config.json` is the single source of
  truth; the deprecated entries are signposts, not a second reader.

## Decisions taken together

| Question | Decision |
|---|---|
| Workspace-scoped values | Leave them alone; user settings only (already the behaviour) |
| The old keys left in `settings.json` | Mark them deprecated in the manifest, and log them once |

## How

### The 25 entries

Exactly what the released 0.0.6 manifest contributed and 1.0.0 does not:

- `acpHub.resume.transcriptDetail` (string), `transcriptMaxCharacters` (number),
  `transcriptMaxToolResultCharacters` (number)
- `acpHub.agents.claude.{enabled (boolean), idleTimeoutSeconds (number),
  idleShutdownMinutes (number), dumpRequests (boolean), authPreference (string),
  toolSearch (string), replaceSystemPrompt (boolean)}`
- `acpHub.agents.codex.{enabled, idleTimeoutSeconds, idleShutdownMinutes,
  dumpRequests, authPreference, maxContextWindow (boolean), replaceSystemPrompt}`
- `acpHub.agents.google.{enabled, idleTimeoutSeconds, idleShutdownMinutes,
  dumpRequests, authPreference, command (string), args (array of strings),
  useAgentBuiltInTools (boolean)}` — Google had no `replaceSystemPrompt` in
  0.0.6.

Each entry is `type` plus `deprecationMessage`, with no `default` (a default
would suggest a value the hub would apply). Two messages:

- **Carried** (22 of them): "Moved to the ACP Hub store. The value you saved was
  carried into `config.json` the first time 1.0.0 ran; change it in the ACP Hub
  sidebar or the control page."
- **Dropped** (`google.command`, `google.args`, `google.useAgentBuiltInTools`):
  "No longer used. The Google agent always runs the Antigravity CLI that ACP Hub
  installs; this value is ignored."

### The generator is what would erase them

`applyRegistry` currently removes every property whose key starts with
`acpHub.agents.` ([vendors.ts](../../../src/core/vendors.ts)). It stays that
way except for one condition: an entry that carries a `deprecationMessage` is
hand-written and is kept. Everything a previous version generated still goes.

The rule reads as one sentence: *generated settings are regenerated; a setting
the extension declares as deprecated is not generated and stays.* When a later
release drops the deprecated block, the condition goes with it.

### The log line

`migrateSettingsOnce` already reads every candidate section. It now also counts
the ones the user had saved, and after a successful run logs one line:

```
settings.json still sets 5 ACP Hub setting(s) the hub reads from its own store now
(acpHub.agents.claude.enabled, acpHub.agents.claude.toolSearch, ...); set them from
the ACP Hub sidebar.
```

At most five keys are named, then `and N more`. It is logged once, because the
migration runs once; a user who never touched settings sees nothing.

The changelog bullet "Upgrading keeps the agents' settings" gains: only values
saved in the user settings are carried, and a value saved in a workspace's
`.vscode/settings.json` is not.

## Tests

- `vendors.test.ts`: an agent-prefixed entry with a `deprecationMessage`
  survives `applyRegistry`; one without it is still dropped (the existing test
  is unchanged, which is the point).
- `vendors.test.ts`: the "contributes only the settings the extension itself
  reads" test keeps checking the three live settings, and additionally requires
  every other property to carry a `deprecationMessage` — no list of 26 to drift.
- `vendors.test.ts`: the deprecated key set equals the 0.0.6 list above (25
  keys), held as a constant in the test, so a key cannot be dropped by accident.
- `settingsMigration.test.ts`: the line names what was left behind; no line when
  the user saved nothing.

## Left to the builder

- Where the block sits inside `contributes.configuration.properties` (after the
  three server settings) and whether it is grouped by agent for readability.
- Whether `args` gets `items: { type: 'string' }` so the deprecated entry is
  still a valid schema.
- The exact wording of the two messages, within the constraints above.
