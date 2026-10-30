# ACP Hub for Copilot — Design

Date: 2026-10-30. Status: draft for approval. Target repo: `C:\Users\cnmid\repos\acp-hub-for-copilot` (public GitHub repo, created after this design is approved).

## Intent and why
The author maintains three VS Code extensions that expose ACP (Agent Client Protocol) agents to GitHub Copilot Chat as language-model providers: `claude-acp-for-copilot`, `codex-acp-for-copilot`, `google-acp-for-copilot`. They are sibling forks; about 70% of `src` is copy-pasted (provider, bridge, sessionStore, rpc, cache, npm, logging, requestDump, customizations, identityPatterns, convert, processes). Every protocol-level change must be applied three times and the copies are drifting (e.g. Google's `requestContext.ts` diverged and Google lacks a usage meter).

ACP Hub replaces them with one extension: one shared core, one small adapter per agent, and a primary-sidebar UI to install, sign in to, configure and monitor agents. Any ACP-registry agent should be addable cheaply later.

## Goals
1. One extension supersedes the three, with parity for Claude, Codex and Google (tested today by the author).
2. Strict adapter pattern: the core talks only to an `AgentAdapter` interface and never branches on agent identity. Adding an agent = adding an adapter (or a registry-driven manifest entry, see below).
3. Primary-sidebar view (Activity Bar container) to: see all agents, install/download each, sign in (browser/OAuth, API key, etc.), change per-agent settings, and view usage. Usage bars move fully into the sidebar; the status bar items go away.
4. Each enabled agent appears in the Copilot model picker as its own provider (own vendor).
5. Plug and play at two levels:
   - Level 1 (no code): a registry-derived manifest entry describes install, launch and ACP-standard auth. The generic adapter handles it. Usage shown only if the agent exposes it.
   - Level 2 (small code): a hand-written adapter overrides only what differs (e.g. Codex rate limits, Claude usage, Google server download).

## Non-goals / anti-goals
- Not a general ACP chat UI; Copilot Chat remains the chat surface.
- No runtime-added vendors; no rewriting `package.json` at runtime.
- Failure even if it "works": core code that contains `if (agent === 'claude')`; copying provider code per agent again; breaking any currently working Claude/Codex/Google behavior.
- Existing three repos are not modified; they remain usable until parity is reached.

## Decided by the author
- Providers are declared statically in `package.json` (`contributes.languageModelChatProviders`), one vendor per agent, **generated from the ACP registry by a build script**. New agents need a release. If this proves too complicated, revisit per-agent providers later (fallback: single vendor, models grouped by agent — not preferred).
- Usage lives only in the sidebar.
- New agents come from the ACP registry (https://agentclientprotocol.com/get-started/agents); registry lists only agents supporting ACP authentication.
- Repo: public, GitHub, name `acp-hub-for-copilot`.

## Agent calls (mine, not author-approved)
- Stack: TypeScript, esbuild, vitest, eslint, `@vscode/test-cli` smoke tests, `vscode ^1.105.0` (same as existing repos).
- Port shared modules from the Claude/Codex repos rather than rewrite; reconcile Google's diverged copies against them.
- Sidebar is a webview view with one card per agent (install state, sign-in state, usage bars, settings), plus an "Add agent" list from the registry manifest.
- Per-agent settings (permissionMode, authPreference, idle timeouts, debug dump, codex maxContextWindow, google command/args overrides) move under a unified `acpHub.agents.<id>.*` scheme; settings migration from the old extensions is a later nice-to-have.
- Secrets in VS Code SecretStorage, keyed by agent id.

## Additions after builder check
Answered by the conversation:
- Source-of-truth repos (read access, authoritative for behavior): `C:\Users\cnmid\repos\claude-acp-for-copilot`, `...\codex-acp-for-copilot`, `...\google-acp-for-copilot`.
- If the static-vendor spike fails, the builder must stop and ask the author; the single-vendor fallback is NOT pre-approved.
- Initial bundled agents: only the three. Level 1 (registry-driven) is proven by a test fixture agent, not shipped for other agents yet.

My calls (author to check):
- Adapter interface may be extended with capability hooks (session-rebuild policy, built-in-tool disabling, usage sources, config merge). Rule: core never branches on agent id; differences are expressed only through adapter capabilities.
- Vendor IDs are new (`acphub-claude`, `acphub-codex`, `acphub-google`) and settings live under `acpHub.*`, so the old extensions can be installed side by side without collisions. No migration of old chat selections or settings in v1.
- Windows is the primary platform and tested one; macOS/Linux are designed for (platform/arch selection in installers, no `shell: true` where avoidable) but not verified in v1.
- Tests: automated unit/integration tests against a mock ACP agent plus fake usage sources; parity with real authenticated agents is verified manually by the author via a checklist in the plan.
- Release scope: local build and public GitHub repo with CI (typecheck, lint, test, package VSIX). Marketplace publishing is out of scope.

## Adapter contract (sketch)
```
interface AgentAdapter {
  id; displayName; vendor;              // vendor must match generated package.json
  install?: Installer;                  // npm package | downloaded binary | existing CLI
  launch(ctx): { command, args, env, shell? };
  auth: AuthMethod[];                   // oauth-browser | api-key | agent-managed
  listModels?(session): Model[];        // else ACP-reported models
  usage?: UsageSource;                  // optional: rate limits / quota / cache ratio
  quirks?: { systemPrompt?, mapError?, configMerge? };  // agent-specific hooks
}
```
Core owns: ACP client/RPC, process supervision (idle shutdown), session store, Copilot provider, request conversion, cache, logging, sidebar host, secret storage, installer runners.

## Known agent-specific facts (from recon of the three repos)
- Claude: `@agentclientprotocol/claude-agent-acp` installed via npm on first use; env `ANTHROPIC_API_KEY`; auth auto/apiKey/oauth; usage = 5h + weekly plan usage + prompt-cache ratio.
- Codex: `@agentclientprotocol/codex-acp` via npm; env `CODEX_API_KEY`, `CODEX_HOME`, `CODEX_CONFIG` merge (MCP timeout; invalid JSON fails session/new); usage via `codex app-server` `account/rateLimits/read`; `maxContextWindow` setting; model catalog from Codex.
- Google: `agy_acp_server` downloaded from dl.google.com; env `GEMINI_API_KEY`, `GOOGLE_ACP_LOGS`; command/args overridable; Windows spawn uses `shell: true` (injection-prone; harden); disables agent built-in tools; rebuilds expired sessions from transcript; no usage meter today.

## Open items for the builder
- Verify VS Code constraint on static vendors and picker behavior in a first spike.
- Define registry manifest schema and the generator script; decide which registry agents are bundled initially (default: only the three).
- Webview tech (plain HTML/TS vs framework) — builder's choice; keep it light.
- Define parity test plan against the three existing extensions.
