# Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the token usage the gateway already receives into one small file per day, and chart it on the control page as a stacked area chart with agent and workspace filters and a retention field.

**Architecture:** A host-neutral ledger in `src/engine/usage` keeps per-day, per-hour, per-workspace, per-agent totals in memory and flushes dirty days to `<storeRoot>/usage/YYYY-MM-DD.json` by read-merge-write under a lock. The HTTP host builds a wire view from it (30 daily, 52 weekly, 24 hourly points), the control page carries that view in its snapshot, and a hand-built SVG renderer draws it. Recording happens in the one `finished` hook the headless composition already owns, in memory only.

**Tech Stack:** TypeScript, Node 20 target, vitest, plain DOM with `innerHTML` strings and inline SVG, esbuild single bundle.

**Spec:** `docs/superpowers/specs/2026-11-10-usage-dashboard-design.md`

## Global Constraints

- The bundle targets Node 20: no `node:sqlite`, no syntax newer than `es2022` in the page bundle.
- No new dependencies. The page stays one self-contained bundle.
- `src/engine/**` must never import `vscode` (`test/unit/engine/boundaries.test.ts` enforces it).
- Nothing in `UsageLedger.record` may do I/O, await, or notify a listener.
- Every file write is async, through a temp file and a rename in the same folder.
- Only retention travels over the action channel; range and filters are page-local.
- The four series, in this order and with these exact labels: `Input`, `Cache read`, `Cache write`, `Output`.
- Retention bounds: `1..365`, default `30`.
- A background request (the host's own call, such as a chat title) is not recorded.

## Review Focus

- **A day file left half-written by a hard kill.** The server must start with the other days intact, not throw.
- **A turn that reported no usage** (failed or cancelled before any model call). It must record nothing — no zero row, no phantom workspace.
- **A workspace path containing backslashes, quotes, or `<`/`&`.** It must survive the JSON round trip and be escaped in the SVG and the filter list.
- **A month with more workspaces than the cap allows.** The payload and the filter list must stay bounded, and the folded `other` row must hold the remainder exactly once.
- **Retention lowered while the server runs.** Old files must actually be deleted and the chart must shrink, not keep drawing from stale memory.
- **A turn that spans local midnight.** Its tokens belong to the hour and day the record was written, and no hour may be double counted.

---

### Task 1: The usage folder and the store's lock helper

**Files:**
- Modify: `src/engine/store/paths.ts`
- Modify: `src/engine/store/fileStore.ts:128-135`
- Test: `test/unit/storageRoot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `usageRoot(root: string): string` — `<root>/usage`, beside the existing `agentsRoot`. `export async function withLock<T>(lockFile: string, action: () => Promise<T>): Promise<T>` from `fileStore.ts`.

- [ ] **Step 1: Write the failing test**

In `test/unit/storageRoot.test.ts`, add:

```ts
it('keeps the usage tallies in a folder of their own under the store root', () => {
	expect(usageRoot('/store')).toBe(path.join(path.resolve('/store'), 'usage'));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/storageRoot.test.ts`
Expected: FAIL — `usageRoot is not a function` or a TypeScript error naming the missing export.

- [ ] **Step 3: Add `usageRoot` and export `withLock`**

In `paths.ts`, a sibling of `agentsRoot` with the same doc-comment style. In `fileStore.ts`, change `async function withLock` to `export async function withLock` and leave its body alone.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/storageRoot.test.ts test/unit/engine/fileStore.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/engine/store/paths.ts src/engine/store/fileStore.ts test/unit/storageRoot.test.ts
git commit -m "feat: add the usage folder beside the agents folder"
```

---

### Task 2: Totals, and recording a turn in memory

**Files:**
- Create: `src/engine/usage/totals.ts`
- Create: `src/engine/usage/ledger.ts`
- Test: `test/unit/usageLedger.test.ts`

**Interfaces:**
- Consumes: `AcpTokenUsage` from `src/engine/acp/protocol`; `Log` from `src/engine/ports/host`.
- Produces:

```ts
// totals.ts
export interface TokenTotals { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number; }
export const UNKNOWN_WORKSPACE = 'unknown';
export const FOLDED_WORKSPACE = 'other';
export function emptyTotals(): TokenTotals;
export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals;
export function isZero(totals: TokenTotals): boolean;
export function localDayKey(at: number): string;      // 'YYYY-MM-DD', local time
export function localHour(at: number): number;        // 0..23
export function weekStartOf(dayKey: string): string;  // the Monday of that day's week

// ledger.ts
export interface UsageRecord { readonly at: number; readonly agent: string; readonly workspace: string | undefined; readonly usage: AcpTokenUsage; readonly background: boolean; }
export interface UsageQuery { readonly agents?: readonly string[]; readonly workspaces?: readonly string[]; }
export interface UsageBucket { readonly key: string; readonly workspace: string; readonly agent: string; readonly totals: TokenTotals; }
export interface UsageLedgerOptions { readonly root: string; readonly retainDays: number; readonly log?: Log; readonly now?: () => number; readonly flushDelayMs?: number; }
export const DEFAULT_RETAIN_DAYS = 30;
export const MAX_RETAIN_DAYS = 365;
export const MAX_WORKSPACES_PER_DAY = 16;
export class UsageLedger {
	constructor(options: UsageLedgerOptions);
	record(record: UsageRecord): void;
	agents(): string[];
	workspaces(): string[];
}
```

`record` adds `usage.inputTokens`, `usage.cachedReadTokens`, `usage.cachedWriteTokens`, `usage.outputTokens + (usage.reasoningOutputTokens ?? 0)` into the row for `(localDayKey(at), localHour(at), workspace ?? UNKNOWN_WORKSPACE, agent)`. It returns at once when `background` is true or `usage` is missing or every count is zero.

- [ ] **Step 1: Write the failing tests**

`test/unit/usageLedger.test.ts`:

```ts
function turn(input: number, cacheRead: number, cacheWrite: number, output: number) {
	return { inputTokens: input, cachedReadTokens: cacheRead, cachedWriteTokens: cacheWrite, outputTokens: output, totalTokens: input + cacheRead + cacheWrite + output };
}

it('counts a turn into the hour, workspace and agent it happened in', () => {
	const ledger = new UsageLedger({ root, retainDays: 30, now: () => at(2026, 11, 10, 13, 30) });
	ledger.record({ at: at(2026, 11, 10, 13, 30), agent: 'claude', workspace: 'C:\\src\\app', usage: turn(100, 900, 40, 300), background: false });
	expect(ledger.daily({}, 1)).toEqual([{ key: '2026-11-10', workspace: 'C:\\src\\app', agent: 'claude', totals: { input: 100, cacheRead: 900, cacheWrite: 40, output: 300 } }]);
});

it('adds reasoning tokens to the output of a turn', () => {
	ledger.record({ ..., usage: { ...turn(0, 0, 0, 300), reasoningOutputTokens: 50 } });
	expect(ledger.daily({}, 1)[0].totals.output).toBe(350);
});

it('records nothing for a background request', () => {
	ledger.record({ ..., background: true });
	expect(ledger.daily({}, 1)).toEqual([]);
	expect(ledger.workspaces()).toEqual([]);
});

it('records nothing for a turn that reported no usage', () => {
	ledger.record({ ..., usage: undefined });
	expect(ledger.daily({}, 1)).toEqual([]);
});

it('files a turn with no known folder under the unknown workspace', () => {
	ledger.record({ ..., workspace: undefined });
	expect(ledger.workspaces()).toEqual(['unknown']);
});

it('keeps only the named agent, the named workspace, or both', () => {
	// four turns: claude@/a, claude@/b, codex@/a, codex@/b, each 1/0/0/0
	expect(ledger.daily({ agents: ['claude'] }, 1)).toHaveLength(2);
	expect(ledger.daily({ workspaces: ['/a'] }, 1)).toHaveLength(2);
	expect(ledger.daily({ agents: ['claude'], workspaces: ['/a'] }, 1)).toEqual([{ key: '2026-11-10', workspace: '/a', agent: 'claude', totals: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } }]);
});

it('files a turn that crosses midnight under the day it was recorded', () => {
	ledger.record({ at: at(2026, 11, 10, 23, 59), agent: 'claude', workspace: '/a', usage: turn(1, 0, 0, 0), background: false });
	ledger.record({ at: at(2026, 11, 11, 0, 1), agent: 'claude', workspace: '/a', usage: turn(2, 0, 0, 0), background: false });
	expect(ledger.daily({}, 2).map(bucket => [bucket.key, bucket.totals.input])).toEqual([['2026-11-10', 1], ['2026-11-11', 2]]);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/usageLedger.test.ts`
Expected: FAIL — the module cannot be resolved.

- [ ] **Step 3: Write `totals.ts` and the recording half of `ledger.ts`**

Keep the in-memory shape `Map<day, Map<`${hour}|${workspace}|${agent}`, TokenTotals>>`, plus a second `Map<day, Map<same key, TokenTotals>>` for the deltas a flush has not yet written. `now` defaults to `Date.now`. `localDayKey` builds the key from the date's local `getFullYear`/`getMonth`/`getDate`, so a turn never lands in a UTC day the user does not recognise. `daily(query, days)` sums the hours of each of the last `days` local days, keeps the buckets the query names (`undefined` lists mean every key), drops zero buckets, and sorts by key, then workspace, then agent.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/usage/totals.ts src/engine/usage/ledger.ts test/unit/usageLedger.test.ts
git commit -m "feat: keep token usage per hour, workspace and agent in memory"
```

---

### Task 3: Flushing a day to disk by merging under a lock

**Files:**
- Modify: `src/engine/usage/ledger.ts`
- Test: `test/unit/usageLedger.test.ts`

**Interfaces:**
- Consumes: `withLock` and `usageRoot` from Task 1.
- Produces: `flush(): Promise<void>`, `close(): Promise<void>`, `onDidFlush(listener: () => void): () => void`, and the day-file shape:

```json
{ "version": 1, "day": "2026-11-10", "rows": [ { "h": 13, "w": "C:\\src\\app", "a": "claude", "in": 100, "cr": 900, "cw": 40, "out": 300 } ] }
```

- [ ] **Step 1: Write the failing tests**

```ts
it('flushes a day to its own file', async () => {
	ledger.record({ ...turn of 100/900/40/300... });
	await ledger.flush();
	const file = path.join(usageRoot(root), '2026-11-10.json');
	expect(JSON.parse(fs.readFileSync(file, 'utf8')).rows).toEqual([{ h: 13, w: 'C:\\src\\app', a: 'claude', in: 100, cr: 900, cw: 40, out: 300 }]);
});

it('merges into a day file another server already wrote', async () => {
	writeDayFile(root, '2026-11-10', [{ h: 13, w: '/other/repo', a: 'codex', in: 5, cr: 0, cw: 0, out: 7 }]);
	ledger.record({ ...our turn... });
	await ledger.flush();
	expect(rowsOf(root, '2026-11-10')).toContainEqual({ h: 13, w: '/other/repo', a: 'codex', in: 5, cr: 0, cw: 0, out: 7 });
});

it('writes only the days that changed', async () => {
	const first = fs.statSync(fileOf('2026-11-09')).mtimeMs;
	ledger.record({ ...a turn on the 10th... });
	await ledger.flush();
	expect(fs.statSync(fileOf('2026-11-09')).mtimeMs).toBe(first);
});

it('tells its listeners once the flush landed', async () => {
	const flushed: number[] = [];
	ledger.onDidFlush(() => flushed.push(1));
	ledger.record({ ... });
	expect(flushed).toEqual([]);
	await ledger.flush();
	expect(flushed).toEqual([1]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/usageLedger.test.ts -t "flush"`
Expected: FAIL — `flush` is not a function.

- [ ] **Step 3: Implement flush, close, `ready()` and the debounce**

On `record`, schedule a timer (`flushDelayMs` default `2000`, unref'd) that calls `flush`. A flush takes the deltas accumulated since the last successful one, and for each dirty day: `withLock(<dayFile>.lock, ...)` → read the file (missing means empty) → add every delta into the matching row, creating it when absent → write through `<file>.<pid>.<seq>.tmp` then rename → keep the delta only if the write threw, which is logged at `warn`. Listeners are called after the writes, not before. `close()` clears the timer and awaits one last flush. `ready()` resolves once the startup load of Task 4 has finished.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/usage/ledger.ts test/unit/usageLedger.test.ts
git commit -m "feat: flush usage days to disk by merging under a lock"
```

---

### Task 4: Reading the store at startup

**Files:**
- Modify: `src/engine/usage/ledger.ts`
- Test: `test/unit/usageLedger.test.ts`

**Interfaces:**
- Consumes: the day-file shape from Task 3.
- Produces: `ready(): Promise<void>`, and the in-memory model rebuilt from disk on construction.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps the totals readable after a reload', async () => {
	ledger.record({ ...turn of 100/900/40/300... });
	await ledger.flush();
	const reloaded = new UsageLedger({ root, retainDays: 30, now: () => at(2026, 11, 10, 14, 0) });
	await reloaded.ready();
	expect(reloaded.daily({}, 1)).toEqual([{ key: '2026-11-10', workspace: 'C:\\src\\app', agent: 'claude', totals: { input: 100, cacheRead: 900, cacheWrite: 40, output: 300 } }]);
});

it('reads the days inside the window at startup and ignores the ones outside it', async () => {
	writeDayFile(root, '2026-11-10', [row(13, 'C:\\src\\app', 'claude', 100, 900, 40, 300)]);
	writeDayFile(root, '2026-01-01', [row(9, 'C:\\src\\app', 'claude', 1, 0, 0, 1)]);
	const ledger = new UsageLedger({ root, retainDays: 30, now: () => at(2026, 11, 10, 14, 0) });
	await ledger.ready();
	expect(ledger.daily({}, 365).map(bucket => bucket.key)).toEqual(['2026-11-10']);
});

it('starts with the other days when one file is corrupt', async () => {
	fs.writeFileSync(fileOf('2026-11-10'), '{"version":1,"day":"2026-11-10","rows":[{');
	writeDayFile(root, '2026-11-09', [row(9, '/repo', 'codex', 2, 0, 0, 3)]);
	const ledger = new UsageLedger({ root, retainDays: 30, now: () => at(2026, 11, 10, 14, 0) });
	await ledger.ready();
	expect(ledger.daily({}, 30).map(bucket => bucket.key)).toEqual(['2026-11-09']);
});

it('skips a day file whose rows are not the expected shape', async () => {
	fs.writeFileSync(fileOf('2026-11-10'), JSON.stringify({ version: 1, day: '2026-11-10', rows: [{ h: 'x' }] }));
	... expect the day to be absent and no throw ...
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/usageLedger.test.ts -t "startup"`
Expected: FAIL.

- [ ] **Step 3: Implement the load**

Read the folder, keep files named `YYYY-MM-DD.json` whose day is inside the retention window, parse each inside a `try`, log a `warn` naming the file when it does not parse or its rows fail the shape check, and load the valid rows into the maps (overwriting nothing: a day present in memory already cannot happen at startup). `ready()` resolves when the load finished; `record` and every query await it first.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/usage/ledger.ts test/unit/usageLedger.test.ts
git commit -m "feat: load the usage days at startup and survive a corrupt one"
```

---

### Task 5: Retention

**Files:**
- Modify: `src/engine/usage/ledger.ts`
- Test: `test/unit/usageLedger.test.ts`

**Interfaces:**
- Consumes: `MAX_RETAIN_DAYS` from Task 2.
- Produces: `retainDays(): number`, `prune(retainDays: number): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('deletes the files and the memory outside the retention window', async () => {
	writeDayFile(root, '2026-10-01', [row(9, '/repo', 'claude', 1, 0, 0, 1)]);
	writeDayFile(root, '2026-11-10', [row(9, '/repo', 'claude', 2, 0, 0, 2)]);
	const ledger = new UsageLedger({ root, retainDays: 365, now: () => at(2026, 11, 10, 14, 0) });
	await ledger.ready();
	expect(ledger.daily({}, 365)).toHaveLength(2);

	await ledger.prune(30);
	expect(fs.existsSync(fileOf('2026-10-01'))).toBe(false);
	expect(ledger.daily({}, 365).map(bucket => bucket.key)).toEqual(['2026-11-10']);
	expect(ledger.retainDays()).toBe(30);
});

it('clamps the window to what the setting allows', async () => {
	await ledger.prune(0);
	expect(ledger.retainDays()).toBe(1);
	await ledger.prune(999);
	expect(ledger.retainDays()).toBe(365);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/usageLedger.test.ts -t "retention"`
Expected: FAIL.

- [ ] **Step 3: Implement prune**

Clamp to `1..MAX_RETAIN_DAYS`, drop the in-memory days before `today + 1 - retainDays` (local), and delete their files with `fs.promises.rm(file, { force: true })`. Log a `warn` per file that fails to delete; never throw from prune.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/usage/ledger.ts test/unit/usageLedger.test.ts
git commit -m "feat: prune usage days beyond the retention window"
```

---

### Task 6: Week and hour buckets, and ordering the workspaces

**Files:**
- Modify: `src/engine/usage/ledger.ts`
- Test: `test/unit/usageLedger.test.ts`

**Interfaces:**
- Consumes: the day rows in memory, and `daily` from Task 2.
- Produces: `weekly(query: UsageQuery, days: number): UsageBucket[]`, `hourlyToday(query: UsageQuery): UsageBucket[]`, and `workspaces(limit?: number): string[]` returning the heaviest workspaces first.

`weekly` keys each bucket by `weekStartOf(day)` — the Monday — and sums the days of that week. Both new queries honour the same `UsageQuery` filter as `daily`.

- [ ] **Step 1: Write the failing tests**

```ts
it('sums a week into one bucket keyed by its Monday', () => {
	// Tuesday 2026-11-10 and Thursday 2026-11-12, same workspace and agent, 1 and 2 input tokens
	expect(ledger.weekly({}, 30)).toEqual([{ key: '2026-11-09', workspace: '/a', agent: 'claude', totals: { input: 3, cacheRead: 0, cacheWrite: 0, output: 0 } }]);
});

it('splits today into the hours that were used', () => {
	// one turn at 09:15 and one at 13:30, today
	expect(ledger.hourlyToday({}).map(bucket => bucket.key)).toEqual(['09', '13']);
});

it('honours the filter in the week and hour views too', () => {
	expect(ledger.weekly({ workspaces: ['/b'] }, 30).every(bucket => bucket.workspace === '/b')).toBe(true);
	expect(ledger.hourlyToday({ agents: ['codex'] }).every(bucket => bucket.agent === 'codex')).toBe(true);
});

it('orders the workspaces by the tokens they spent', () => {
	expect(ledger.workspaces()).toEqual(['/heavy', '/light']);
	expect(ledger.workspaces(1)).toEqual(['/heavy']);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/usageLedger.test.ts -t "week"`
Expected: FAIL.

- [ ] **Step 3: Implement the three queries over the in-memory maps**

Aggregate on read. Week buckets sum the days whose `weekStartOf` matches. `hourlyToday` returns today's rows keyed by `String(hour).padStart(2, '0')`. `workspaces(limit)` sums every row of every retained day per workspace, orders by the total input-plus-output descending, and slices. Skip buckets whose totals are zero; sort by `key`, then workspace, then agent so the wire order is stable.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/usage/ledger.ts test/unit/usageLedger.test.ts
git commit -m "feat: query usage by week and hour, and rank the workspaces"
```

---

### Task 7: The workspace cap

**Files:**
- Modify: `src/engine/usage/ledger.ts`
- Test: `test/unit/usageLedger.test.ts`

**Interfaces:**
- Consumes: the queries from Task 6.
- Produces: no signature change. The cap applies inside `record`: when a day would hold more than `MAX_WORKSPACES_PER_DAY` distinct workspaces, the least-used one is folded into `FOLDED_WORKSPACE` (`'other'`).

- [ ] **Step 1: Write the failing tests**

```ts
it('folds the least used workspace into one other row once the day is full', async () => {
	for (let n = 0; n < MAX_WORKSPACES_PER_DAY + 1; n += 1) {
		ledger.record({ ..., workspace: `/repo/${n}`, usage: turn(10 * (n + 1), 0, 0, 0) });
	}
	const workspaces = ledger.workspaces();
	expect(workspaces).toHaveLength(MAX_WORKSPACES_PER_DAY);
	expect(workspaces).toContain('other');
	const total = ledger.daily({}, 1).reduce((sum, bucket) => sum + bucket.totals.input, 0);
	expect(total).toBe(sumOfEveryTurnRecorded());   // no token is lost or counted twice
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/unit/usageLedger.test.ts -t "folds"`
Expected: FAIL — 17 workspaces come back.

- [ ] **Step 3: Implement the fold**

When adding a record whose workspace is new for that day and the day already holds `MAX_WORKSPACES_PER_DAY` workspaces, find the workspace with the smallest day total and add its rows into `'other'` for the same hour and agent before adding the new record. `'other'` never folds into itself.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/usage/ledger.ts test/unit/usageLedger.test.ts
git commit -m "feat: bound the workspaces a usage day keeps"
```

---

### Task 8: The history surface and the wire view

**Files:**
- Create: `src/hosts/http/usageSurface.ts`
- Modify: `src/ui/messages.ts`
- Test: `test/unit/usageSurface.test.ts`

**Interfaces:**
- Consumes: `UsageLedger` (Tasks 2–7).
- Produces:

```ts
// messages.ts, next to ModelsView/ModelsSurface
export interface UsagePoint { d: string; w: number; a: number; v: [number, number, number, number]; }
export interface UsageHistoryView {
	retentionDays: number;
	agents: { id: string; name: string }[];
	workspaces: { id: string; name: string }[];
	days: UsagePoint[];
	weeks: UsagePoint[];
	today: UsagePoint[];
	empty: boolean;
}
export interface UsageHistorySurface {
	view(): Promise<UsageHistoryView>;
	setRetentionDays(days: number): Promise<void>;
}

// usageSurface.ts
export interface UsageSurfaceDeps {
	readonly ledger: UsageLedger;
	readonly agents: readonly { id: string; displayName: string }[];
	readonly writeRetention: (days: number) => Promise<void>;
}
export function createUsageHistorySurface(deps: UsageSurfaceDeps): UsageHistorySurface;
```

`view()` caches: it rebuilds only after the ledger's `onDidFlush` fired or `setRetentionDays` ran, and hands the same object back otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
it('caps the payload at 8 workspaces by folding the rest into other', async () => {
	// 12 workspaces, one turn each with distinct sizes
	const view = await surface.view();
	expect(view.workspaces).toHaveLength(8);
	expect(view.workspaces.at(-1)?.id).toBe('other');
	expect(sumOf(view.days)).toBe(sumOfEveryTurn());
});

it('names an agent the registry no longer has by its id, and keeps its history', async () => {
	// a row for 'retired-agent', agents list of one other
	expect(view.agents.map(a => a.name)).toContain('retired-agent');
	expect(view.days.some(p => p.a === indexOf('retired-agent'))).toBe(true);
});

it('names a workspace by its last path segment and keeps the full path as the id', async () => {
	expect(view.workspaces).toContainEqual({ id: 'C:\\src\\app', name: 'app' });
});

it('carries 30 daily, 52 weekly and 24 hourly grids', async () => {
	expect(view.days.length).toBeLessThanOrEqual(30 * 8 * 3);
	expect(view.weeks.length).toBeLessThanOrEqual(52 * 8 * 3);
	expect(view.today.length).toBeLessThanOrEqual(24 * 8 * 3);
});

it('rebuilds only after a flush', async () => {
	const first = await surface.view();
	expect(await surface.view()).toBe(first);
	await ledger.flush();
	expect(await surface.view()).not.toBe(first);
});

it('marks an empty store', () => expect((await emptySurface.view()).empty).toBe(true));

it('stores the retention it was given and prunes', async () => {
	await surface.setRetentionDays(7);
	expect(written).toEqual([7]);
	expect((await surface.view()).retentionDays).toBe(7);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/usageSurface.test.ts`
Expected: FAIL — the module cannot be resolved.

- [ ] **Step 3: Implement the surface**

Build the three grids from `ledger.daily`, `ledger.weekly`, `ledger.hourlyToday`, mapping workspace and agent keys to their index in the two lists (workspaces from `ledger.workspaces(8)`, agents from the union of the data's keys and the registry ids, data first). Folding beyond 8 is done by asking the ledger for the 8 heaviest and passing the rest through a query whose workspace list is exactly those 8, so the remaining rows have to be summed into one extra `other` list entry — do that by querying twice: once restricted to the top 8, once unrestricted, and taking the difference per key. Agent names come from the registry's `displayName`, workspace names from `path.basename`, both falling back to the raw id.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageSurface.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/http/usageSurface.ts src/ui/messages.ts test/unit/usageSurface.test.ts
git commit -m "feat: build the usage history view for the page"
```

---

### Task 9: Recording, and carrying the view to the page

**Files:**
- Modify: `src/composition/headless.ts:160-200` and `:64-90`
- Modify: `src/hosts/http/server.ts:117-125`, `:170-215`
- Modify: `src/ui/controlPage.ts:60-90`, `:100-135`, `:196-207`
- Test: `test/unit/controlPage.test.ts`, `test/unit/engine/headlessWiring.test.ts`

**Interfaces:**
- Consumes: `UsageLedger`, `createUsageHistorySurface`, `UsageHistoryView`.
- Produces:
  - `HeadlessGateways.ledger: UsageLedger` and `HeadlessGateways.usageHistory: UsageHistorySurface`.
  - `ControlPage`'s third constructor argument becomes an options object `{ models?: ModelsSurface; usage?: UsageHistorySurface }`.
  - `ControlState.usage?: UsageHistoryView`.
  - `FromWebview` gains `{ type: 'setRetentionDays'; days: number }`.
  - The ledger is created in `createHeadlessComposition` with `retainDays` read from `host.settings.get<number>('usage.retentionDays') ?? DEFAULT_RETAIN_DAYS`, and `writeRetention` awaits `host.writeSetting('usage.retentionDays', days)` then `ledger.prune(days)`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/controlPage.test.ts`:

```ts
it('offers no usage view when the host has no ledger', async () => {
	expect((await page.state()).usage).toBeUndefined();
});

it('carries the usage view in the snapshot', async () => {
	expect((await pageWithUsage.state()).usage).toEqual(sampleView);
});

it('writes the retention the page asked for', async () => {
	await pageWithUsage.handle({ type: 'setRetentionDays', days: 14 });
	expect(surface.setRetentionDays).toHaveBeenCalledWith(14);
});
```

In `test/unit/engine/headlessWiring.test.ts`: one test that a finished turn for an adapter, driven through the composition with a mocked `finished` turn object, leaves one bucket in `composition.ledger.daily({}, 1)` with the turn's counts, and one that a background turn leaves none.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/controlPage.test.ts test/unit/engine/headlessWiring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire it**

Create the ledger beside `usage` in `createHeadlessComposition`, add the `record` call as the last line of the existing `finished` hook, await `ledger.close()` in `close()` before the agents stop, expose both on `HeadlessGateways`, build the surface in `createServer` and pass it through `openPage` to `ControlPage`, add `usage` to `state()`, and route `setRetentionDays` in `handle`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/controlPage.test.ts test/unit/engine/headlessWiring.test.ts test/unit/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composition/headless.ts src/hosts/http/server.ts src/ui/controlPage.ts test/unit/controlPage.test.ts test/unit/engine/headlessWiring.test.ts
git commit -m "feat: record turn tokens and carry the usage view to the page"
```

---

### Task 10: The area chart renderer

**Files:**
- Create: `src/ui/chart.ts`
- Test: `test/unit/usageChart.test.ts`

**Interfaces:**
- Consumes: nothing from the page.
- Produces:

```ts
export const SERIES: readonly [
	{ key: 'input'; label: 'Input'; className: 'series-input' },
	{ key: 'cacheRead'; label: 'Cache read'; className: 'series-cache-read' },
	{ key: 'cacheWrite'; label: 'Cache write'; className: 'series-cache-write' },
	{ key: 'output'; label: 'Output'; className: 'series-output' },
];
export interface ChartPoint { readonly label: string; readonly values: readonly [number, number, number, number]; }
export function renderAreaChart(points: readonly ChartPoint[], options?: { readonly height?: number }): string;
export function renderChartLegend(totals: readonly [number, number, number, number]): string;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('draws one stacked area per series', () => {
	const html = renderAreaChart([{ label: '2026-11-09', values: [10, 20, 0, 5] }, { label: '2026-11-10', values: [0, 40, 0, 15] }]);
	expect(html.match(/<path class="series-/g)).toHaveLength(4);
});

it('labels the axis with the peak of the stack', () => {
	const html = renderAreaChart([{ label: 'a', values: [10, 20, 0, 5] }]);
	expect(html).toContain('35');                 // 10 + 20 + 0 + 5
});

it('says so when there is nothing to draw', () => {
	expect(renderAreaChart([])).toContain('No usage recorded yet.');
});

it('escapes a label that carries markup', () => {
	expect(renderAreaChart([{ label: '<b>&', values: [1, 0, 0, 0] }])).not.toContain('<b>');
});

it('gives each legend entry its own colour class and the range total', () => {
	const html = renderChartLegend([1000, 2000, 0, 500]);
	expect(html).toContain('series-cache-read');
	expect(html).toContain('3k');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/usageChart.test.ts`
Expected: FAIL — the module cannot be resolved.

- [ ] **Step 3: Implement the renderer**

An `<svg viewBox="0 0 600 {height}" role="img">`, one polygon per series stacked on the ones before it, `class="series-input"` and so on, a `<title>` per column carrying the label and the four numbers, three y labels drawn with the token formatter the page already has (move it into `chart.ts` and have `render.ts` import it, so there is one copy), and sparse x labels at the first, middle and last point. All text is escaped through the existing `escapeHtml`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/usageChart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/chart.ts test/unit/usageChart.test.ts src/ui/render.ts
git commit -m "feat: draw the usage area chart"
```

---

### Task 11: The Usage view on the page

**Files:**
- Modify: `src/ui/render.ts:214-230` (nav and a new `renderUsageView`)
- Modify: `src/ui/page.ts`
- Modify: `media/sidebar.css`
- Test: `test/unit/sidebarRender.test.ts`

**Interfaces:**
- Consumes: `UsageHistoryView`, `renderAreaChart`, `renderChartLegend`.
- Produces: `type PageView = 'agents' | 'models' | 'usage'`; `renderNav(view: PageView, available: { readonly models: boolean; readonly usage: boolean }): string`, which draws the Models tab only when `models` and the Usage tab only when `usage`; `renderUsageView(view: UsageHistoryView, selection: UsageSelection, notice?: string): string`; and

```ts
export interface UsageSelection {
	readonly range: 'today' | '7' | '30' | 'all';
	readonly agents: ReadonlySet<string>;
	readonly workspaces: ReadonlySet<string>;
}
```

Page-local state and actions: `showUsage`, `setUsageRange` (`data-range`), `toggleUsageAgent` (`data-agent-filter`), `toggleUsageWorkspace` (`data-workspace-filter`), `resetUsageFilters`, and `setRetentionDays` (the only one that leaves the page). `renderNav`'s existing callers change to pass both flags; `draw()` renders the nav when either capability is present.

- [ ] **Step 1: Write the failing tests**

```ts
it('draws the Usage tab beside Agents and Models', () => {
	expect(renderNav('usage', { models: true, usage: true })).toContain('data-action="showUsage"');
});

it('hides a tab the host cannot fill', () => {
	expect(renderNav('agents', { models: false, usage: false })).not.toContain('data-action="showUsage"');
});

it('shows the retention field, the filters and the chart', () => {
	const html = renderUsageView(sampleView, { range: '7', agents: new Set(), workspaces: new Set() });
	expect(html).toContain('data-action="setRetentionDays"');
	expect(html).toContain('data-agent-filter="claude"');
	expect(html).toContain('data-workspace-filter="/repo/app"');
	expect(html).toContain('<svg');
});

it('sums only the selected agent and workspace into the chart', () => {
	const html = renderUsageView(sampleView, { range: '7', agents: new Set(['claude']), workspaces: new Set() });
	expect(chartTotal(html)).toBe(totalOfClaudeOnly(sampleView));
});

it('escapes a workspace path that carries markup', () => {
	const view = { ...sampleView, workspaces: [{ id: '/repo/<b>&', name: '<b>&' }] };
	expect(renderUsageView(view, { range: '7', agents: new Set(), workspaces: new Set() })).not.toContain('<b>');
});

it('explains an empty history once', () => {
	expect(renderUsageView(emptyView, { range: '30', agents: new Set(), workspaces: new Set() }))
		.toContain('Recording starts now; usage before this update was never stored.');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/sidebarRender.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the view, the page state and the colours**

In `page.ts`: `view` gains `'usage'`; `range`, `usageAgents` and `usageWorkspaces` are local state; `draw()` routes to `renderUsageView` when `state.usage` exists and the tab is `'usage'`, and draws the nav when either `models` or `usage` is present, passing both flags to `renderNav`; the click handler covers the new actions and sends only `setRetentionDays`. In `renderUsageView`, offer the `all` range only when `retentionDays` is over 30, and clamp the selected range to the retention otherwise. In `sidebar.css`: `--chart-input`, `--chart-cache-read`, `--chart-cache-write`, `--chart-output` under `:root` (four distinct hues, legible on both `--vscode-sideBar-background` values), four `path.series-*` rules using them, plus plot and legend layout.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/unit/sidebarRender.test.ts test/unit/modelsPage.test.ts test/unit/controlTransport.test.ts`
Then: `npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/ui/render.ts src/ui/page.ts media/sidebar.css test/unit/sidebarRender.test.ts
git commit -m "feat: add the Usage view with filters, range and retention"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: `test/unit/packaging.test.ts` (existing; it reads `package.json`, so no change unless it enumerates page features)

**Interfaces:** none.

- [ ] **Step 1: Add the feature to the README's page description**

One short paragraph under whatever section describes the control page: the Usage view charts token usage over time, filterable by agent and workspace, with the retention setting beside it, and one sentence that history starts at the update because earlier usage was never stored.

- [ ] **Step 2: Add a CHANGELOG entry**

Under the unreleased version, one bullet in the project's existing voice.

- [ ] **Step 3: Run the suite**

Run: `npx vitest run`
Then: `npm run lint`
Expected: PASS both.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe the usage dashboard"
```

---

## Verification before handing back

- [ ] `npm run typecheck` passes.
- [ ] `npx vitest run` passes.
- [ ] `npm run lint` passes.
- [ ] Restart the server, open the page, run one chat, and confirm the Usage tab draws a point after a couple of seconds, that the agent and workspace filters change the totals, that lowering retention removes days, and that `usage/YYYY-MM-DD.json` sits under the store root.
