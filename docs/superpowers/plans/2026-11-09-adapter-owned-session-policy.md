# Adapter-Owned Session Behaviour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every adapter-specific decision from the core's session machinery and replace it with a `SessionPolicy` each adapter implements, behind import walls that make the leak impossible to reintroduce.

**Architecture:** The core keeps one algorithm (open, resume, fork, rewind, rebuild) and asks `adapter.sessionPolicy` what to do at the four points where it currently reads a boolean flag. Adapters own the decision; core owns the execution. A boundary test and eslint restrictions forbid the old imports.

**Tech Stack:** TypeScript, esbuild, vitest (`npm test`), eslint (`npm run lint`), `tsc --noEmit` (`npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-11-09-two-host-core-design.md`

## Global Constraints

- `npm run typecheck`, `npm run lint` and `npm test` must pass at the end of every task, with one deliberate exception: **Tasks 1–4 are a single TDD cycle.** Task 1 lands the boundary test red and Tasks 2–3 turn it green; the suite must be fully green again at the end of Task 4. No other task may leave the suite red.
- The extension's behaviour must not change. `test/unit/forkChats.test.ts` (34 tests) is the equivalence proof and must pass unmodified except where a task says otherwise.
- No file under `src/core` may contain an agent id, vendor or display-name comparison — `test/unit/noAgentBranching.test.ts` enforces this.
- No adapter may import from `src/core` anything outside the allow-list defined in Task 1.
- Do not rename `AgentAdapter` or move files between directories in this plan; the directory move is a later plan.
- Keep the existing code style: tabs, single quotes, the file's existing comment idiom, no new dependencies.

## Review Focus

- **An adapter that sets a `forker` while its agent also advertises `session/fork`.** The plan must say which wins; both today's behaviour and a user's expectation (use the protocol's own fork) must agree.
- **A policy that plans `fork` for an agent that turned out not to advertise it.** The core must fall back to a rebuild, not throw, and the chat must still answer.
- **Two chats mid-turn on the same saved session.** Keeping the source id and restarting must never end another chat's in-flight turn.
- **A `toolWaitMs` of 0, negative or `NaN`.** The core must clamp to a positive finite wait when a policy names one; an *unset* value keeps today's "wait as long as the agent does", because bounding that belongs to the host, not this plan.
- **A new adapter that omits `sessionPolicy` entirely.** It must behave exactly like today's Claude/Codex adapters, from a default, without touching core.

---

### Task 1: Import walls that fail first

**Files:**
- Create: `test/unit/boundaries.test.ts`
- Create: `test/unit/support/boundaries.ts`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Produces: `allowedAdapterCoreImports: readonly string[]` in `test/unit/support/boundaries.ts` — the exact module paths (relative to `src/core/`) an adapter may import. Tasks 2–4 make the suite pass.

- [ ] **Step 1: Write the failing test**

`test/unit/support/boundaries.ts` exports the rules:

```ts
export const allowedAdapterCoreImports = [
	'adapter',            // the port itself
	'agentClient',        // protocol types only
	'hostIdentity',       // the shared identity sentence
	'logging',            // the Log type
	'registry',           // registry lookups
	'vendors',            // vendor id and settings keys
	'rpc',                // RpcError
	'sessionStore',       // message fingerprints
	'processes',          // child-process tree helpers
] as const;
```

Wait — that list is the *current* state, not the target. The test must assert the **target** list, which is smaller. Write it as the target and let it fail:

```ts
export const allowedAdapterCoreImports = [
	'adapter',
	'agentClient',
	'hostIdentity',
	'logging',
	'registry',
	'vendors',
	'sessionFingerprint',
	'protocol',
	'processHost',
] as const;
```

`test/unit/boundaries.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedAdapterCoreImports } from './support/boundaries';

function adapters(): string[] {
	return readdirSync('src/adapters').filter(name => name.endsWith('.ts')).map(name => join('src/adapters', name));
}

describe('adapter boundaries', () => {
	it('adapters import core only through the declared surface', () => {
		for (const file of adapters()) {
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(/from '\.\.\/core\/([^']+)'/g)) {
				const module = match[1].replace(/\.ts$/, '');
				expect(allowedAdapterCoreImports, `${file} imports core/${module}`).toContain(module);
			}
		}
	});

	it('adapters do not import vscode', () => {
		for (const file of adapters()) {
			expect(readFileSync(file, 'utf8')).not.toMatch(/from 'vscode'/);
		}
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/boundaries.test.ts`
Expected: FAIL, naming `src/adapters/googleFork.ts imports core/sessionStore`, `src/adapters/googleHub.ts imports core/processes`, `src/adapters/googleQuota.ts imports core/rpc`.

- [ ] **Step 3: Add the eslint restriction that mirrors the test head**

In `eslint.config.mjs`, add a config block for `src/adapters/**/*.ts` with `no-restricted-imports` patterns `../core/sessionStore`, `../core/processes`, `../core/rpc`, and messages naming the replacement module. This is the editor-time half of the same rule.

- [ ] **Step 4: Run lint to confirm the rule reports the same three files**

Run: `npm run lint`
Expected: three `no-restricted-imports` errors, one per file above. Do not fix them yet; Tasks 2–4 do.

- [ ] **Step 5: Commit**

```bash
git add test/unit/boundaries.test.ts test/unit/support/boundaries.ts eslint.config.mjs
git commit -m "test: enforce the adapter import boundary before fixing it"
```

---

### Task 2: A protocol module so adapters stop importing the ACP client

**Files:**
- Create: `src/core/protocol.ts`
- Modify: `src/core/agentClient.ts` (re-export the moved types; keep every existing export name working)
- Modify: `src/core/rpc.ts` (move `RpcError` here-out, see step 3)
- Test: `test/unit/protocol.test.ts`

**Interfaces:**
- Produces: `src/core/protocol.ts` exporting `AcpAuthMethod`, `AcpTokenUsage`, `AcpContentBlock`, `AgentSession`, `ForkPoint`, `RpcError`. `agentClient.ts` imports them from there; `adapters/{claude,codex,google,googleFork,googleQuota}.ts` import them from `../core/protocol`.

- [ ] **Step 1: Write the failing test**

`test/unit/protocol.test.ts`:

```ts
import { expect, it } from 'vitest';
import { RpcError } from '../../src/core/protocol';

it('RpcError keeps its code and message', () => {
	const error = new RpcError(-32000, 'Authentication required');
	expect(error.code).toBe(-32000);
	expect(error.message).toBe('Authentication required');
	expect(error).toBeInstanceOf(Error);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/protocol.test.ts`
Expected: FAIL — cannot resolve `../../src/core/protocol`.

- [ ] **Step 3: Move the types and the error**

Move the interface declarations from `agentClient.ts` (`AcpAuthMethod`, `AcpTokenUsage`, `AcpContentBlock`, `AgentSession`, `ForkPoint`) and `RpcError` from `rpc.ts` into `src/core/protocol.ts`, unchanged. In `agentClient.ts` and `rpc.ts`, re-export them (`export type { ... } from './protocol'`, `export { RpcError } from './protocol'`) so no other import site changes. Leave `rpc.ts`'s `isAuthRequiredError` and `RpcConnectionClosedError` where they are.

- [ ] **Step 4: Run the new test and the whole suite**

Run: `npx vitest run test/unit/protocol.test.ts test/unit/agentClient.test.ts test/unit/rpc.test.ts`
Expected: PASS, including the existing ACP tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/protocol.ts src/core/agentClient.ts src/core/rpc.ts test/unit/protocol.test.ts
git commit -m "refactor: move ACP protocol types out of the client"
```

---

### Task 3: Fingerprints and process helpers as adapter-safe modules

**Files:**
- Create: `src/core/sessionFingerprint.ts`
- Create: `src/core/processHost.ts`
- Modify: `src/core/sessionStore.ts` (re-export `shortHash`, `messageFingerprintOf`)
- Modify: `src/core/processes.ts` (re-export `killTree`, `trackChild`)
- Modify: `src/adapters/googleFork.ts:7`, `src/adapters/googleHub.ts:4`, `src/adapters/googleQuota.ts:1`
- Test: `test/unit/sessionFingerprint.test.ts`

**Interfaces:**
- Produces: `shortHash(text: string): string`, `messageFingerprintOf(text: string): string` from `sessionFingerprint`; `killTree(pid: number): Promise<void>`, `trackChild(pid: number): void` from `processHost`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from 'vitest';
import { messageFingerprintOf } from '../../src/core/sessionFingerprint';
import { messageFingerprintOf as fromStore } from '../../src/core/sessionStore';

it('the adapter-facing fingerprint is the session store fingerprint', () => {
	expect(messageFingerprintOf('one\n\ntwo')).toBe(fromStore('one\n\ntwo'));
	expect(messageFingerprintOf('')).toHaveLength(16);
});
```

(The length assertion pins the current truncation; read it from the existing implementation and use the real value.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/sessionFingerprint.test.ts`
Expected: FAIL — cannot resolve `sessionFingerprint`.

- [ ] **Step 3: Move the functions**

Move `shortHash` and `messageFingerprintOf` into `sessionFingerprint.ts` verbatim; `sessionStore.ts` re-exports them so existing importers are untouched. Do the same for `killTree` and `trackChild` into `processHost.ts`, re-exported from `processes.ts`. Update the two adapter imports only.

- [ ] **Step 4: Run the boundary test and the suite**

Run: `npx vitest run test/unit/boundaries.test.ts test/unit/sessionFingerprint.test.ts test/unit/sessionStore.test.ts test/unit/processes.test.ts`
Expected: `googleFork`/`googleHub`/`googleQuota` violations gone; every other test passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/sessionFingerprint.ts src/core/processHost.ts src/core/sessionStore.ts src/core/processes.ts src/adapters/googleFork.ts src/adapters/googleHub.ts test/unit/sessionFingerprint.test.ts
git commit -m "refactor: give adapters a narrow surface for fingerprints and processes"
```

---

### Task 4: `SessionPolicy` on the adapter contract, with a native default

**Files:**
- Create: `src/core/sessionPolicy.ts`
- Modify: `src/core/adapter.ts` (add `sessionPolicy?: SessionPolicy` — optional, so an adapter that omits it gets the default)
- Create: `src/core/nativeSessionPolicy.ts`
- Test: `test/unit/sessionPolicy.test.ts`

**Interfaces:**
- Produces: `SessionPolicy`, `ContinuationInput`, `ContinuationPlan`, `OpenPromptInput`, `policyOf(adapter: AgentAdapter): SessionPolicy`, and `nativeSessionPolicy: SessionPolicy`.

```ts
export interface LiveSessionInfo {
	readonly chatKey: string;
	readonly sessionId: string;
	readonly hasTurn: boolean;
}

export interface ContinuationInput {
	readonly saved: SavedSession;
	readonly live: readonly LiveSessionInfo[];
	readonly editedOwnChat: boolean;
	readonly agentSupportsFork: boolean;
	readonly externalForker: ConversationForker | undefined;
}

export type ContinuationPlan =
	| { readonly how: 'resume' }
	| { readonly how: 'fork-native' }
	| { readonly how: 'fork-external'; readonly keepSourceId: boolean; readonly restartFirst: boolean }
	| { readonly how: 'rebuild' };

export interface OpenPromptInput {
	readonly saved: SavedSession;
	readonly rebuilt: string | undefined;
}

export interface SessionPolicy {
	planContinuation(input: ContinuationInput): ContinuationPlan;
	promptForOpen(input: OpenPromptInput): string | undefined;
	toolsChangedAction(): 'reopen' | 'list-changed';
	toolWaitMs(settings: AgentSettings): number;
}
```

- [ ] **Step 1: Write the failing tests**

`test/unit/sessionPolicy.test.ts` covers the default and the clamp:

```ts
it('uses the agent fork when the agent advertises it', () => {
	expect(nativeSessionPolicy.planContinuation(input({ agentSupportsFork: true }))).toEqual({ how: 'fork-native' });
});

it('uses the external forker when the adapter has one and the agent does not fork', () => {
	const plan = nativeSessionPolicy.planContinuation(input({ agentSupportsFork: false, externalForker: fakeForker }));
	expect(plan.how).toBe('fork-external');
});

it('rebuilds when neither mechanism exists', () => {
	expect(nativeSessionPolicy.planContinuation(input({ agentSupportsFork: false }))).toEqual({ how: 'rebuild' });
});

it('never disables the tool wait', () => {
	for (const value of [0, -1, Number.NaN]) {
		expect(nativeSessionPolicy.toolWaitMs({ toolWaitTimeoutMs: value })).toBeGreaterThan(0);
	}
	expect(nativeSessionPolicy.toolWaitMs({})).toBe(Number.POSITIVE_INFINITY);
});
```

(`Number.POSITIVE_INFINITY` for an unset value preserves today's "wait as long as the agent does"; the *bound* comes from the host, see the Review Focus.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/sessionPolicy.test.ts`
Expected: FAIL — cannot resolve `sessionPolicy` / `nativeSessionPolicy`.

- [ ] **Step 3: Add the types, the default policy, and the accessor**

Write `sessionPolicy.ts` with the declarations above. Write `nativeSessionPolicy` so that it reproduces today's Claude/Codex behaviour exactly: `agentSupportsFork` wins over a forker (`fork-native`), a forker alone gives `fork-external` with `keepSourceId: false, restartFirst: false`, otherwise `rebuild`; `promptForOpen` returns `rebuilt`; `toolsChangedAction()` returns `'reopen'`; `toolWaitMs` returns `settings.toolWaitTimeoutMs` when it is a positive finite number and `Infinity` otherwise. Add `policyOf(adapter)` returning `adapter.sessionPolicy ?? nativeSessionPolicy`; the core uses only that accessor from here on, so an adapter without a policy behaves like today's Claude.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/sessionPolicy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/sessionPolicy.ts src/core/nativeSessionPolicy.ts src/core/adapter.ts test/unit/sessionPolicy.test.ts
git commit -m "feat: add SessionPolicy to the adapter contract"
```

The old flags stay in place through this task, so every existing reader keeps compiling; Tasks 5 and 6 move those readers and then delete the flags.

---

### Task 5: Core asks the policy — Claude and Codex on the default

**Files:**
- Modify: `src/core/provider.ts:275-285` (tools changed), `:545-570` (open prompt), `:654-720` (fork), `:840-860` (tools changed)
- Modify: `src/core/provider/warmSession.ts:85-95`
- Modify: `src/core/provider/turns.ts:305-312`
- Modify: `src/adapters/claude.ts`, `src/adapters/codex.ts` (add `sessionPolicy: nativeSessionPolicy`)
- Test: `test/unit/forkChats.test.ts` (must pass unchanged), `test/unit/sessionPolicy.test.ts` (add the two-chats case)

**Interfaces:**
- Consumes: `policyOf`, `SessionPolicy`, `ContinuationPlan` from Task 4.
- Produces: `AcpProvider.fork(reuse, options, point, editedOwnChat)` keeps its signature; the body switches on `plan.how`.

- [ ] **Step 1: Add the failing equivalence test**

In `test/unit/sessionPolicy.test.ts`, add the mid-turn case: with two live sessions on the same saved `sessionId`, one of them holding a turn, `keepSourceId` must be `false` for an external fork and the plan must still be `fork-external`. This test fails until `planContinuation` receives `live`.

- [ ] **Step 2: Replace each flag read with a policy call**

- Tools changed: `policyOf(this.adapter).toolsChangedAction() === 'list-changed'` replaces `adapter.refreshesTools === true` / `!== true` at both sites.
- Open prompt: `policyOf(this.adapter).promptForOpen({ saved: reuse.saved, rebuilt: systemPromptAppend })` replaces both `keepsSessionPrompt` branches.
- Fork: build `ContinuationInput` from `reuse`, the live `this.sessions`, `editedOwnChat`, `agent.supportsFork` and `adapter.forker`, then run the plan: `resume` → `resumeSession`; `fork-native` → `forkSession`; `fork-external` → the existing forker path with `keepSourceId`/`restartFirst` from the plan (delete the inline `busyChats`/`keepSourceId` computation); `rebuild` → return `undefined`.
- Tool wait: `policyOf(this.adapter).toolWaitMs(settings)`.
- `declaresBridgeOnModelLookup` stays as it is (it is a fact, not a decision).

- [ ] **Step 3: Run the equivalence proof**

Run: `npx vitest run test/unit/forkChats.test.ts test/unit/sessionPolicy.test.ts`
Expected: PASS, `forkChats.test.ts` with no edits to its assertions.

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/provider.ts src/core/provider/warmSession.ts src/core/provider/turns.ts src/adapters/claude.ts src/adapters/codex.ts test/unit/sessionPolicy.test.ts
git commit -m "refactor: ask the adapter's session policy instead of reading its flags"
```

---

### Task 6: Google owns its fork behaviour; the flags disappear

**Files:**
- Create: `src/adapters/googleSessionPolicy.ts`
- Modify: `src/adapters/google.ts` (add `sessionPolicy: googleSessionPolicy`)
- Modify: `src/core/adapter.ts` (delete `forkChats`, `restartAfterFork`, `keepsSessionPrompt`, `rebuildExpiredSessions`, `systemPromptNote`, `toolWaitTimeoutMs`, `refreshesTools` if no reader remains)
- Test: `test/unit/adapters/googleSessionPolicy.test.ts`

**Interfaces:**
- Produces: `googleSessionPolicy: SessionPolicy` in the Google adapter.

- [ ] **Step 1: Write the failing tests**

`test/unit/adapters/googleSessionPolicy.test.ts` pins the four cases that today live in `provider.fork()`:

```ts
it('keeps the source id only when the chat edited its own earlier message and nothing else is mid-turn', () => {
	const plan = googleSessionPolicy.planContinuation({ saved, live: [], editedOwnChat: true, agentSupportsFork: false, externalForker: forker });
	expect(plan).toEqual({ how: 'fork-external', keepSourceId: true, restartFirst: true });
});

it('takes a new id when another chat is mid-turn', () => {
	const plan = googleSessionPolicy.planContinuation({ saved, live: [{ chatKey: 'b', sessionId: 'other', hasTurn: true }], editedOwnChat: true, agentSupportsFork: false, externalForker: forker });
	expect(plan).toEqual({ how: 'fork-external', keepSourceId: false, restartFirst: false });
});

it('takes a new id for a copy of another chat', () => {
	const plan = googleSessionPolicy.planContinuation({ saved, live: [], editedOwnChat: false, agentSupportsFork: false, externalForker: forker });
	expect(plan.keepSourceId).toBe(false);
});

it('rebuilds without a forker, and reuses the saved prompt', () => {
	expect(googleSessionPolicy.planContinuation({ saved, live: [], editedOwnChat: true, agentSupportsFork: false, externalForker: undefined })).toEqual({ how: 'rebuild' });
	expect(googleSessionPolicy.promptForOpen({ saved, rebuilt: 'new' })).toBe(saved.prompt);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/adapters/googleSessionPolicy.test.ts`
Expected: FAIL — cannot resolve `googleSessionPolicy`.

- [ ] **Step 3: Implement the policy and delete the flags**

Write the policy so it reproduces the decisions now made in `provider.ts:654-720` and the `keepsSessionPrompt` branch, then delete the now-unread properties from `adapter.ts`. `sessionPolicy` stays optional so a new adapter inherits the default. Any adapter that still sets a deleted property is a compile error: remove that line.

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm run lint && npm test && npx vitest run test/unit/boundaries.test.ts`
Expected: PASS, including the boundary suite with the target allow-list.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/googleSessionPolicy.ts src/adapters/google.ts src/core/adapter.ts test/unit/adapters/googleSessionPolicy.test.ts
git commit -m "feat(google): own the fork decision in the adapter"
```

---

### Task 7: A conformance suite for every adapter

**Files:**
- Create: `test/unit/adapters/conformance.test.ts`
- Modify: `docs/parity-checklist.md` (one line saying the contract is machine-checked)

**Interfaces:**
- Consumes: `ADAPTERS` from `src/core/agents.ts`, `policyOf` from `src/core/sessionPolicy.ts`.

- [ ] **Step 1: Write the failing test**

For each adapter in `ADAPTERS`, assert the contract is complete and executable:

```ts
for (const adapter of ADAPTERS) {
	describe(adapter.id, () => {
		it('resolves a session policy, even when the adapter declares none', () => expect(policyOf(adapter)).toBeDefined());
		it('plans a continuation for every combination the core can pass', () => {
			for (const agentSupportsFork of [true, false]) {
				for (const externalForker of [undefined, fakeForker]) {
					for (const editedOwnChat of [true, false]) {
						const plan = policyOf(adapter).planContinuation({ saved, live, editedOwnChat, agentSupportsFork, externalForker });
						expect(['resume', 'fork-native', 'fork-external', 'rebuild']).toContain(plan.how);
						if (plan.how === 'fork-external') { expect(externalForker, `${adapter.id} plans an external fork without a forker`).toBeDefined(); }
					}
				}
			}
		});
		it('returns a usable tool wait', () => expect(policyOf(adapter).toolWaitMs({})).not.toBeNaN());
		it('names no other agent', () => {
			const text = readFileSync(`src/adapters/${adapter.id}.ts`, 'utf8');
			for (const other of ADAPTERS.filter(candidate => candidate.id !== adapter.id)) {
				expect(text, `${adapter.id} names ${other.id}`).not.toMatch(new RegExp(`['"\\\`]${other.id}['"\\\`]`));
			}
		});
	});
}
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/unit/adapters/conformance.test.ts`
Expected: PASS if Tasks 5–6 are correct; any adapter whose policy disagrees with what the core can execute fails here.

- [ ] **Step 3: Prove the guard bites**

Temporarily change `nativeSessionPolicy.planContinuation` to return `{ how: 'fork-external', keepSourceId: true, restartFirst: false }` with no forker, run the conformance test, and confirm it fails with the adapter's name. Revert.

- [ ] **Step 4: Update the parity checklist**

Add one line: the adapter contract is checked by `test/unit/adapters/conformance.test.ts`, so a new adapter must add a policy or inherit `nativeSessionPolicy`.

- [ ] **Step 5: Run everything and commit**

```bash
npm run typecheck && npm run lint && npm test
git add test/unit/adapters/conformance.test.ts docs/parity-checklist.md
git commit -m "test: check every adapter against the session-policy contract"
```

---

## Self-Review

**Spec coverage.** This plan implements design step 5 (`SessionPolicy`) and the adapter-facing half of the boundary rules, reordered before the directory move so the extracted `ChatService` never contains the policy.
Not covered here, by design — each is its own plan producing working software:
- design steps 1–4: `src/engine`, neutral model, `HostPort`, `ChatService` extraction;
- step 6: the shared store and the `StateStore`/`SecretStore` implementations;
- step 7: `ControlService` and `src/ui`;
- step 8: the remaining scalability items (process registry per workspace, per-owner quotas, launch cache, bridge stream cap);
- step 9: the HTTP host and `server.ts`.

**Step scan.** Every step names a file, a command, or an interface. No step says "handle edge cases".

**Type consistency.** `SessionPolicy`, `ContinuationInput`, `ContinuationPlan`, `OpenPromptInput` and `policyOf` are defined once (Task 4) and used with the same names in Tasks 5–7. `LiveSessionInfo` is used only inside `ContinuationInput`.

**Review Focus coverage.** Every line has a test: the fork/forker precedence in Task 4 (`uses the agent fork when the agent advertises it`), the impossible plan in Task 7 step 3, the mid-turn case in Tasks 5 and 6, the clamp in Task 4 (`never disables the tool wait`), and the missing policy in Task 7's conformance loop.
