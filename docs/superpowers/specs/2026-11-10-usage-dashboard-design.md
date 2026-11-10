# Usage dashboard design

## Intent

The gateway already receives the token counts of every finished turn, but it forgets them. The page can say what an account's quota is today; it cannot say where the tokens went last week, or which workspace spent them.

This adds a Usage view to the server's page: one stacked area chart of token kinds over time, a global total with filters for agents and workspaces, and a retention setting on the same page.

## Goals

- One area chart. Four series, each its own colour: fresh input, cache read, cache write, output.
- A global view, filterable by agent and by workspace, with both filters combined.
- History that survives a restart of the server or of VS Code.
- Retention configurable on the Usage view itself.
- No added latency on the chat path, and no agent is started to answer a dashboard request.

## Non-goals

- Cost in currency. No pricing data exists in this repo.
- Per-model breakdown, per-chat drill-down, or a table of individual turns.
- Hourly history older than the current day.
- Replacing the per-agent usage cards, which show the provider's own account quota.

## Anti-goals

These are ways the feature would technically work but be a failure:

- A synchronous file write on the turn-completion path.
- The ledger stored inside `state.json`, which every turn already rewrites whole under a lock.
- Re-reading day files while drawing the page.
- Arbitrary grouping or raw export. That need would justify a database instead of files.
- A charting dependency. The page is deliberately one self-contained bundle.

## Constraints found in the code

1. The token hook is on the critical path. Every finished turn calls the host's `finished` callback from the turn writer, **before** the final `done` chunk is handed to the client. The callback returns `void` and is not awaited, so anything synchronous in it delays the last chunk of every response.
2. There is exactly one place where every chat passes: the headless composition wires one `ChatService` per agent, and all chats — VS Code and Copilot CLI alike — go through that server process. Tokens need recording in one hook only.
3. The workspace is already known at that hook: the finished turn carries the chat identity, whose `cwd` is the folder the chat works in. The server derives it from the request; the extension from its window.
4. All page state travels one channel. Both the webview sidebar and the browser tab receive `ControlState` snapshots, pushed over SSE on the HTTP host. The webview has no `fetch`, so a separate dashboard endpoint would work in the browser and not in the sidebar.
5. The page is plain DOM plus `innerHTML` strings, no framework, bundled once to `dist/sidebar.js`, with per-host CSS.
6. The webview's CSP allows inline `style` attributes but not inline scripts; the HTTP page has no CSP. Inline SVG built into the `innerHTML` satisfies both.
7. Some agents report no cache split. For those, `cachedReadTokens` and `cachedWriteTokens` are always zero and everything is counted as fresh input. The chart must not imply a zero cache read in that case, so the series legend carries the note that cache counts are agent-reported.
8. `usage.retentionDays` belongs to the same settings mechanism the page already uses for global settings (`readGlobalSetting`/`writeGlobalSetting`, stored as `acpHub.<key>` in `config.json`).

## Approaches considered

**How the data reaches the page**

- **A (chosen).** A third tab in the existing page, built like the Models tab. The snapshot carries the aggregate; filter changes are page-local.
- **B.** A separate endpoint the page fetches when the tab is open. Rejected: the webview cannot `fetch`, so the sidebar would need a second path anyway; and the HTTP host would need the token guard repeated on a new route.

**How the chart is drawn**

- **Hand-built inline SVG inside the existing render functions (chosen).** No dependency, colours from the theme's CSS variables, same drawing approach as every other view.
- **A bundled charting library.** Rejected: a dependency and ~40–60 KB added to a single-file bundle, for axes and tooltips that are a few dozen lines here.

**Where filtering happens**

- **Client-side (chosen).** The snapshot carries per-day rows grouped by workspace and agent; the page sums the selected subset. Keeps the action channel as the only synchronization path, and the filters stay per-tab, which is how a user expects a filter to behave.
- **Server-side.** Rejected for now: it needs per-connection filter state in the page/transport layer, which is a larger change to a recently settled abstraction. It also shares one filter between the sidebar and any open browser tab, because there is one control page per server.

**Why files rather than SQLite.** The server still supports Node 20, where the built-in SQLite module does not exist; third-party bindings are native and would have to ship per platform instead of the current single bundle. At a few hundred turns a day the data is ~100k rows a year, where insert cost is irrelevant either way. Files keep the extension dependency-free; the daily-tally shape keeps the file count and file size bounded.

## Design

### 1. The ledger

A new host-neutral module `src/engine/usage/ledger.ts`. It may use `node:fs` (as `src/engine/store/fileStore.ts` already does) but must not import `vscode`, which is what the engine boundary test enforces.

**Storage.** One file per local day: `<storageRoot>/usage/YYYY-MM-DD.json`, added to `src/engine/store/paths.ts` beside `agentsRoot`.

```json
{
  "version": 1,
  "day": "2026-11-10",
  "rows": [
    { "h": 13, "w": "C:\\src\\app", "a": "claude", "in": 120, "cr": 9000, "cw": 40, "out": 300 }
  ]
}
```

- A row is keyed by `(hour, workspace, agent)`. Hourly rows in every day file, including finished days: aggregation to a day happens on read. One shape, no migration when a day rolls over.
- `w` is the chat's `cwd`, verbatim. The display name is its last path segment; the full path is the tooltip. Grouping by `cwd` rather than by window folders means a multi-root window shows one entry per folder a chat actually ran in.
- Days are local dates and hours are local hours, taken at record time. If the machine's timezone changes, later rows land in the new local day; already-written rows are not rewritten.
- A row with an unknown workspace (`chat` missing at the hook) is stored under the single key `"unknown"`.

**Caps.** Per day file: hours 24, workspaces 16, agents as many as have ever reported. Beyond 16 workspaces in a day, the least-used workspace row is folded into a `"other"` row rather than dropped. Worst case is therefore 24 × 16 × ~6 rows; a typical day is 24 × 3 × 3 ≈ 216 rows, tens of KB.

**In memory.** At construction the ledger reads the files inside the retention window into `Map<day, Map<key, Totals>>` and keeps that as the read model. `record()` only mutates the maps, marks the day dirty, and accumulates the same numbers in a separate per-day delta map. The page is drawn from these maps, never from disk.

**Flushing, with a second writer in mind.** More than one server process can share one store: the extension starts a server, and a hand-started second one on another port reaches the same folder. So a flush is not a blind whole-file write. It is a read, merge and write of only the dirty day files — the day file is read back, the deltas accumulated since the last successful flush are added into matching rows, and the result is written — under the same kind of lock file `fileStore` already uses for `state.json`. Rows from the other writer therefore survive. The lock helper is private to the store module today; export it rather than writing a second one.

The flush is debounced (about 2 s after the last record) and writes asynchronously. `close()` flushes anything pending before the process exits, on the composition's existing close path. A hard kill loses at most the debounce window.

**Retention.** The ledger holds `retainDays` (default 30). On construction, and whenever the setting changes, files whose day is older than the window are deleted and their in-memory days dropped. Lowering the setting prunes immediately and is irreversible; the page says so next to the field.

**Read API.** `series({ range })` returns points for the range, plus the hourly split for today. `workspaces()` and `agents()` return the keys present in the data, not the registry: a disabled or uninstalled agent keeps the numbers it already spent, and a workspace whose folder is gone still appears. Names come from the registry or the adapter list when the key is known there, and fall back to the raw id or path when it is not.

**Buckets per range.** Retention bounds storage, not the width of the chart, so the two are separate settings:

| Range | Points | Bucket |
| --- | --- | --- |
| Today | up to 24 | hour |
| 7 days | 7 | day |
| 30 days | 30 | day |
| All (offered only when retention is over 30) | up to 52 | week |

A week bucket is the host's own grouping of its daily rows, not a second stored shape. Both the daily and weekly views cap the payload at the 8 heaviest workspaces for the range, folding the rest into the existing `"other"` row, which keeps the largest realistic snapshot near a thousand rows rather than growing with retention.

### 2. Recording

In `createHeadlessComposition`, the existing `finished: turn => …` hook gains one call, after `usage.recordTurn`:

```ts
ledger.record({ at: Date.now(), agent: adapter.id, workspace: turn.chat?.cwd, usage: turn.usage, background: turn.background });
```

- Skipped when `turn.usage` is undefined, and skipped for background requests (the host's own calls, such as a chat title), matching how the existing cache figures already treat them. Tokens spent on titles are therefore not charted; this is recorded in the design so a builder does not "fix" it by accident.
- `record` is in-memory only. Nothing is awaited and nothing is written on this call.

### 3. Wiring to the page

- `HeadlessGateways` exposes the ledger, alongside `control` and `usage`.
- `createServer` builds a `UsageSurface` (the page-facing view, like `ModelsSurface` today) from the ledger, the adapters, and the host's settings, then passes it to `openPage`, which hands it to `ControlPage`.
- `ControlState` gains `usage?: UsageView`. Absent on a host that has no ledger, so the tab simply does not appear.
- `UsageView` is a wire-shaped view model, not the ledger's internals:

```ts
{
  retentionDays: number;
  agents: { id: string; name: string }[];
  workspaces: { id: string; name: string }[];
  // v = input, cache read, cache write, output; w and a index the lists above
  days: { d: string; w: number; a: number; v: [number, number, number, number] }[];   // last 30 days at most
  weeks: { d: string; w: number; a: number; v: [number, number, number, number] }[];  // whole retention, weekly
  today: { h: number; w: number; a: number; v: [number, number, number, number] }[];  // 24 hours at most
  empty: boolean;
}
```

`w` and `a` index into `workspaces` and `agents`, and `v` is positional, so a retained month with a handful of workspaces stays a few KB per push rather than tens. All three grids are bounded by the point counts above, whatever the retention: 30 daily, 52 weekly, 24 hourly. The page picks the grid for the selected range, so changing range or filter costs no round trip and the snapshot cannot grow with history.

- **Redrawing without a write per turn.** `record()` must not notify anyone: a publish on every finished turn would rebuild and serialize the view on the chat path's coattails. Instead the surface keeps the last built `UsageView` and rebuilds it only when the ledger reports that a flush landed, which is itself debounced. `ControlPage.publish()` then runs at most once per flush, a few seconds apart, and a quiet server costs nothing. A redraw for any other reason reuses the cached view.

- A new action `setRetentionDays` writes `usage.retentionDays` through the existing global-setting path and asks the ledger to prune, which invalidates the cached view. No other action is needed: the range and the filters are page-local.

### 4. The view

- `renderNav` gains a Usage tab, drawn only when `state.usage` is present.
- A new `src/ui/chart.ts` holds the SVG builder, so `render.ts` does not grow another renderer. It returns a string, like every other renderer here.
- The chart: stacked areas, one `<path>` per series, x = day (or hour when the range is "Today"), y = tokens, y-axis labelled with the existing token formatter (k/M), sparse x labels, `<title>` per column for a native tooltip. Below the plot, a legend with a colour swatch per series and the total for the range.
- Colours are four CSS custom properties defined in `media/sidebar.css`, so they can be tuned in one place and stay readable in both light and dark VS Code themes. The four series use distinct hues, not shades of one.
- Filters: a checkbox per agent and per workspace, each group with an "All" reset. Selections live in the page's local state (like `editing` today) and redraw from the snapshot without a round trip.
- Range: Today / 7 days / 30 days, plus All when retention is over 30, clamped to the retention window.
- Retention: a number field on the Usage view, saved on change. It is rendered here and not in the Agents view's global-settings block, although it uses the same storage.
- Empty state: "No usage recorded yet." with one line explaining that recording starts now and earlier usage was never stored.

### 5. Retention setting

`usage.retentionDays`, integer, minimum 1, maximum 365, default 30. Stored in `config.json` as `acpHub.usage.retentionDays` through the same settings writer the page's global settings already use, but written by its own `setRetentionDays` action rather than by the generic `setGlobalSetting` handler: the field is rendered only on the Usage view, and it has to prune the ledger as well as store a number.

### 6. Costs, documented so nobody re-derives them

- Per turn: four integer additions and a map lookup. No I/O and no notification.
- Per flush: a read, a merge and a small JSON rewrite per dirty day, at most once every couple of seconds.
- Per redraw: a filtered sum over the cached view, at most once per flush.
- Payload: a retained month with three workspaces and three agents is ~8–15 KB per snapshot push; the 8-workspace cap and the per-range bucket keep the worst case bounded as retention grows.

## Tests

Unit (vitest, `test/unit/`):

- Ledger: recording adds to the right day, hour, workspace and agent; a finished day aggregates its hours on read; a query filters by agent and by workspace, and by both together.
- Ledger: retention deletes files and in-memory days outside the window; lowering the window prunes immediately.
- Ledger: the workspace cap folds the least-used workspace into the "other" row and never exceeds it.
- Ledger: a corrupt or truncated day file is skipped, not fatal.
- Ledger: a flush writes only dirty days, and a reload of the store reproduces the same totals.
- Ledger: two ledgers over one folder both keep their rows, because a flush merges into the day file instead of overwriting it.
- Ledger: weekly bucketing of a 90-day history yields whole weeks whose totals equal the daily totals.
- Chart: the rendered string has one path per series, the expected peak in the axis label, and the empty state when there are no days.
- Control page: a snapshot without a ledger omits the Usage tab; a snapshot with one includes it and the current filters survive a redraw.
- Control page: the view is rebuilt once per flush, not on every snapshot.

## What this design leaves to the builder

- The exact debounce interval and flush-error handling (log and retry next flush is the expectation).
- The four palette values, within the "distinct hues, readable in both themes" constraint.
- The SVG geometry: plot height, label density, how the axis steps.
- Whether the "other" workspace bucket is shown in the filter list.
- Whether an agent with no cache reporting gets a hint in the legend.
