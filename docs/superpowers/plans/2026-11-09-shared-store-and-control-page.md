# Shared Store and Control Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Both gateways read and write one on-disk store, and the sidebar's functions are reachable from a browser page that shares the sidebar's renderer.

**Spec:** docs/superpowers/specs/2026-11-09-two-host-core-design.md ("One store, two gateways", "The control page").

## Global Constraints
- `src/engine/**` keeps zero `vscode` imports. No new dependencies.
- Extension behaviour unchanged; `forkChats.test.ts` untouched.
- Every task ends with tsc, lint and the suite green.

## Task 1 — file-backed store
- [ ] Failing test `test/unit/engine/fileStore.test.ts`: round-trip a value; two writers incrementing a counter never lose an update (lock); secrets file is written with mode 0600; a corrupt file is reported, not silently replaced.
- [ ] `src/engine/store/paths.ts`: `storageRoot()` = `ACP_HUB_HOME` or `~/.acp-hub`.
- [ ] `src/engine/store/fileStore.ts`: `createFileStore(root)` → `{ state: StateStore; secrets: SecretStore }`, JSON at `state.json`/`secrets.json`, temp-file + rename, `revision` field, lock file with stale-lock recovery.
- [ ] Headless host uses it instead of its own copy.
- [ ] Commit `feat(engine): add the shared file store`.

## Task 2 — the extension adopts the store
- [ ] Failing test: `stateStoreOf(memento)` migration copies every `acpHub.*` key once, under a marker, and leaves the Memento values in place.
- [ ] `src/extension.ts` builds the store at `storageRoot()` and passes it as `ProviderDeps.state`; `AgentSecretStore` gains a file backend with `SecretStorage` as a mirror; migrate `signedIn.<id>`, `sidebar.visibleAgents`, `acpHub.savedSessions.*`, `acpHub.models.*`, `acpHub.forkNotice.*`.
- [ ] Commit `feat(store): share one store between the gateways`.

## Task 3 — ControlService
- [ ] Failing test: the service answers every operation the sidebar needs (list, install state, install/uninstall, sign in/out, read/write setting, enable, usage, visible agents) against fakes.
- [ ] `src/engine/control/ControlService.ts` lifts the dependency object from `extension.ts` into a host-free service taking `HostPort` + store + installers + usage.
- [ ] `src/sidebar/host.ts` delegates to it; `extension.ts` only wires.
- [ ] Commit `feat(engine): add ControlService`.

## Task 4 — the page
- [ ] Move `src/sidebar/{render,messages}.ts` and `webview/main.ts` to `src/ui/`, parameterised by a `ControlTransport`.
- [ ] VS Code transport = `postMessage`; HTTP transport = `/api/state`, `/api/action`, `/api/events` (SSE), and `GET /` serves the bundle.
- [ ] Failing test: the same renderer output for the same state in both transports; an action round-trips.
- [ ] Commit `feat(ui): serve the sidebar page from the server`.
