# Client-owned System Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every piece of client-specific prompt text and parsing out of the server, so the VS Code extension builds the whole system prompt as labelled sections and the server only joins, compares and applies them.

**Architecture:** The wire gains `acp.systemPrompt.sections` (id, label, text, kind). The engine replaces its Copilot-aware guidance string with those sections: it joins them for the opening prompt, compares them by section mid-chat, and hashes them for session reuse. The extension takes over the Copilot knowledge (identity stripping, per-chat parts, mode split, notes, instruction-file pointers, tool arguments) and reads `replaceSystemPrompt` from `config.json`. The MCP tool server is renamed `vscode` → `hub`.

**Tech Stack:** TypeScript, Node, VS Code extension API, vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-22-client-owned-system-prompt-design.md`

## Global Constraints

- Server code (everything bundled into `dist/server.js`: `src/main`, `src/composition`, `src/engine`, `src/adapters`, `src/hosts/http`, and the `src/core` files they import) gets no client-specific text, tag parsing, file conventions or names. See `.github/copilot-instructions.md`.
- Two chats that differ only in which chat they are produce a byte-identical opening prompt.
- Same inputs → same bytes: fixed section order, sorted tool lists, no timestamps, no ids in the opening prompt.
- The opening prompt is used only when a session opens; every later change goes as a message.
- Sections are joined with `'\n\n'`. The server adds no text of its own to the prompt.
- Section kinds: none = in the prompt, compared, hashed; `fixed` = in the prompt, never compared, not hashed; `chat` = not in the prompt (sent ahead of `chatContext` in the opening message), compared, not hashed.
- Tool server name: `hub`. Tools reach the model as `mcp__hub__<name>` (Claude, Codex) and `mcp_hub_<name>` (Google).
- Retraction wording: `The "<label>" instructions no longer apply.`
- `API_VERSION` = 2.
- Commands: `npm run typecheck`, `npm run lint`, `npx vitest run <files>`, `npm run generate`, `npm run generate:check`. Files use LF line endings.
- Every commit message ends with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## Review Focus

1. A Copilot prompt with no mode line, as sub-agent or inline requests send. Expected: no `mode:` section and nothing retracted. Test in Task 6.
2. A request with no tools, such as a chat title. Expected: the agent gets no prompt and no `chat` section text, as today. Test in Task 3.
3. A client that speaks API version 1 against the new server. Expected: `systemGuidance` alone still works as one `guidance` section, and the server reports version 2. Test in Task 2.
4. `config.json` missing, the setting unset, or the setting not a boolean. Expected: replace is treated as off. Test in Task 6.
5. An extra-account agent id (for example `claude-work`). Expected: it reads the type's `replaceSystemPrompt` and tool-name format. Test in Task 6.

---

### Task 1: Prompt sections in the engine (pure functions)

**Files:**
- Create: `src/engine/chat/promptSections.ts`
- Modify: `src/engine/model/chat.ts` (add `PromptSection`)
- Modify: `src/engine/chat/types.ts` (`GuidanceChange`)
- Modify: `src/engine/chat/assemble.ts` (`guidanceChangeBlock`)
- Test: `test/unit/engine/promptSections.test.ts` (new), `test/unit/assemble.test.ts`

**Interfaces:**
- Produces:
  - `src/engine/model/chat.ts`: `export interface PromptSection { readonly id: string; readonly label?: string; readonly text: string; readonly kind?: 'fixed' | 'chat' }`
  - `src/engine/chat/promptSections.ts`:
    - `export interface SavedSection { readonly id: string; readonly label?: string; readonly lines: readonly string[] }` (`lines` are line hashes)
    - `openingPromptOf(sections: readonly PromptSection[] | undefined): string | undefined` joins non-`chat` sections and gives `undefined` when empty
    - `chatPartOf(sections: readonly PromptSection[] | undefined): string | undefined` joins the `chat` sections
    - `sectionsHashOf(sections): string` hashes the unmarked sections only (`shortHash` of folded text)
    - `promptsDiffer(before, after): boolean` compares non-`fixed` sections by id and folded text
    - `savedSectionsOf(sections): SavedSection[]` gives the non-`fixed` sections with their line hashes
    - `promptChangeOf(saved: readonly SavedSection[] | undefined, after: readonly PromptSection[] | undefined, before?: readonly PromptSection[]): GuidanceChange`
    - `mergePromptChange(first: GuidanceChange, second: GuidanceChange): GuidanceChange`
  - `GuidanceChange` (types.ts): `added`, `removed`, `goneLines?` as today. `leftMode` is replaced by `retired?: ReadonlyArray<{ readonly id: string; readonly label: string }>` plus `addedSections?: readonly string[]`.

- [ ] **Step 1: Write the failing tests** in `test/unit/engine/promptSections.test.ts`:
  - `joins the sections of the prompt in order and leaves chat sections out`: `[{id:'a',text:'A'},{id:'c',kind:'chat',text:'C'},{id:'f',kind:'fixed',text:'F'}]` gives `openingPromptOf` → `'A\n\nF'` and `chatPartOf` → `'C'`.
  - `gives two chats the same opening prompt when only their chat sections differ`: equal `openingPromptOf` and equal `sectionsHashOf`.
  - `hashes only unmarked sections, folding case and spacing`: changing a `fixed` or `chat` section keeps the hash; `'Use Tabs'` vs `' use  tabs '` keeps the hash; changing an unmarked section changes it.
  - `tells a changed chat section but not a changed fixed section`: `promptsDiffer` is true for a chat-section change and false for a fixed-section change.
  - `retires a labelled section that is gone and sends the new one whole`: saved `savedSectionsOf([{id:'guidance',text:'Rules'},{id:'mode:Agent',label:'Agent mode',text:'You are currently running in "Agent" mode.\nDo work'}])` against after `[{id:'guidance',text:'Rules'},{id:'mode:Ask',label:'Ask mode',text:'Ask line'}]`, with `before` set to the same saved sections. Expected: `retired` is `[{id:'mode:Agent',label:'Agent mode'}]`, `added` is `['Ask line']`, `addedSections` is `['mode:Ask']`, and `goneLines` is `[]`.
  - `lists the lines of an unlabelled section that is gone`: `goneLines` holds its lines and `retired` is empty or undefined.
  - `treats a session saved without sections as knowing nothing`: `promptChangeOf(undefined, after)` gives `added` = all lines and `removed` = 0.
  - `cancels a retirement when the section returns before the change is sent`: merge Agent→Ask with Ask→Agent. Expected: no `retired`.
  - In `test/unit/assemble.test.ts`: `names each retired section by its label` checks that `guidanceChangeBlock({added:[],removed:2,retired:[{id:'mode:Agent',label:'Agent mode'}],goneLines:[]})` contains `The "Agent mode" instructions no longer apply.` and does not contain `no longer in`.

- [ ] **Step 2: Run** `npx vitest run test/unit/engine/promptSections.test.ts test/unit/assemble.test.ts`. Expected: FAIL (module missing; old wording).

- [ ] **Step 3: Implement** `promptSections.ts`, the `PromptSection` type, the `GuidanceChange` change, and the `guidanceChangeBlock` retraction line.
  - Folding is `squashGuidance` from `keys.ts` without the `session-state` replacement: collapse whitespace, trim, `\` → `/`, lower-case.
  - Line hashes are `shortHash` of the folded line, de-duplicated as `guidanceLines` does today.
  - `added` and `removed` stay global across sections, so a line that moved between sections is not new.
  - `goneLines` is set only when `before` is given, and leaves out lines of retired sections.
  - Merge rules:
    - `retired` = `first.retired` minus ids in `second.addedSections`, plus `second.retired` minus ids in `first.addedSections`.
    - `addedSections` = `first.addedSections` minus ids `second` retired, plus `second.addedSections`.
    - `added`, `removed` and `goneLines` merge as in `mergeGuidanceChange` today.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(engine): prompt sections with a generic section diff`.

---

### Task 2: Wire contract and HTTP host carry sections

**Files:**
- Modify: `src/hosts/http/wire.ts` (`AcpPromptSection`, `AcpRequestExtras.systemPrompt`, `API_VERSION = 2`)
- Modify: `src/hosts/http/server.ts:860-960` (`acpExtrasOf`, replace `guidanceOf` with `promptOf`)
- Modify: `src/engine/model/chat.ts` (`ChatRequest.systemGuidance?: string` → `systemPrompt?: readonly PromptSection[]`)
- Modify: `src/engine/ports/host.ts` (`guidanceOf(request): string | undefined` → `promptOf(request): readonly PromptSection[] | undefined`)
- Modify: `src/hosts/http/host.ts` (`promptOf: request => request.systemPrompt`)
- Test: `test/unit/engine/chatWire.test.ts`, `test/unit/engine/httpHost.test.ts`, `test/unit/server.test.ts`

**Interfaces:**
- Consumes: `PromptSection` (Task 1).
- Produces:
  - `wire.ts`: `export interface AcpPromptSection { id: string; label?: string; text: string; kind?: 'fixed' | 'chat' }`, plus `AcpRequestExtras.systemPrompt?: { sections: AcpPromptSection[] }`.
  - `systemGuidance` stays and is documented as the older single-section form.
  - `HostPort.promptOf`.

- [ ] **Step 1: Write the failing tests** in `chatWire.test.ts`:
  - `passes the client's sections to the engine in order`: body `acp.systemPrompt.sections` of three sections with kinds gives `request.systemPrompt` deep-equal to them.
  - `drops a section with no id or no text, and an unknown kind`: invalid entries are absent and the valid ones are kept.
  - `reads an older client's systemGuidance as one guidance section`: `acp: { systemGuidance: 'Rules' }` gives `[{ id: 'guidance', text: 'Rules' }]`.
  - `reads a stock client's system message as one guidance section`: no `acp` and a system message `'Be brief'` gives `[{ id: 'guidance', text: 'Be brief' }]`.
  - `adds the reply rules as the last section`: `response_format: { type: 'json_object' }` gives a last section `{ id: 'reply-rules', text: <the JSON rule> }`.
  - In `server.test.ts` (or wherever `/health` is asserted): `/health` answers `apiVersion: 2`.

- [ ] **Step 2: Run** `npx vitest run test/unit/engine/chatWire.test.ts test/unit/engine/httpHost.test.ts test/unit/server.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `promptOf(body, messages, extras): PromptSection[] | undefined` in `server.ts`.
  - Use the client's sections when there are any; otherwise make one `guidance` section from `systemGuidance` (when `body.acp` is an object) or from `systemTextOf(messages)` (when it isn't).
  - Then add `reply-rules` when `replyRulesOf(body)` is non-empty, its rules joined with `'\n\n'`.
  - Give `undefined` when nothing is left.
  - Update `HostPort`, the headless host, `ChatRequest`, and every test fake that implements `guidanceOf` (grep `guidanceOf:` under `test/`) to `promptOf`.

- [ ] **Step 4: Run** the same command. Expected: these tests PASS. `npm run typecheck` still fails in `ChatService.ts` and `reuse.ts` until Task 3 is done.

- [ ] **Step 5: No commit yet.** Tasks 2 and 3 are committed together at the end of Task 3, so every commit typechecks.

---

### Task 3: Engine uses sections; the server stops writing prompt text

**Files:**
- Modify: `src/engine/chat/types.ts` (`ChatContext.guidance: string | undefined` → `prompt: readonly PromptSection[] | undefined`)
- Modify: `src/engine/chat/ChatService.ts` (lines ~316, ~408, ~456, ~735-815, ~998-1040; remove `buildSessionPrompt` from deps)
- Modify: `src/engine/chat/reuse.ts`, `src/engine/chat/sessionStore.ts` (`SavedSession.promptSections?: readonly SavedSection[]`; keep reading `guidanceLines`)
- Modify: `src/engine/chat/keys.ts` (delete `splitChatGuidance`, `guidanceDiffers`, `guidanceHashOf`, `guidanceLineHashes`, `guidanceChangeOf`, `mergeGuidanceChange`, `SESSION_*`, `MODE_*`, `squashGuidance`)
- Delete: `src/engine/chat/systemPrompt.ts`, `src/core/systemPrompt.ts`
- Modify: `src/composition/headless.ts` (drop `createSessionPrompt`, `workspaceOf`, the `promptsDir` option), `src/main/server.ts:99` (drop `ACP_HUB_PROMPTS_DIR`)
- Test: `test/unit/engine/forkChats.test.ts`, `test/unit/sessionStore.test.ts`, `test/unit/engine/chatService.test.ts`, `test/unit/engine/boundaries.test.ts`, `test/unit/systemPrompt.test.ts` (delete; its cases move to Task 6)

**Interfaces:**
- Consumes: Task 1 functions and `HostPort.promptOf` (Task 2).
- Produces: `ChatContext.prompt`. The `systemPromptAppend` an agent gets is exactly `openingPromptOf(context.prompt)` for requests that offer tools.

- [ ] **Step 1: Write the failing tests.** In `forkChats.test.ts`, change `harness()` so that:
  - `promptOf` returns the sections a test puts on the request (the helper `system(text)` becomes `[{ id: 'guidance', text }]`);
  - `buildSessionPrompt` is gone.

  Then:
  - `opens the session with the client's sections and nothing else`: sections `A`, `B` (fixed) give `openedWith` = `'A\n\nB'`.
  - Rewrite `describe('the session prompt of a new chat')` with sections instead of Copilot tags:
    - two chats with the same `guidance` and different `{ id: 'chat', kind: 'chat', text: 'Session folder: …/<id>' }` give an identical `openedWith`, which contains no `Session folder`;
    - the first prompt of each chat contains its own chat text;
    - the next message of the chat does not repeat it.
  - `tells a changed chat section mid-chat`: a second request with a changed chat section gives a next prompt that contains the new line.
  - `sends no change when only a fixed section changed`.
  - `retracts the mode it left`: `mode:Agent` → `mode:Ask` gives a next prompt containing `The "Agent mode" instructions no longer apply.`
  - `gives a request with no tools no prompt and no chat section` (Review Focus 2).
  - In `sessionStore.test.ts`: `resumes a session saved with guidanceLines only, sending the lines it never saw`.

- [ ] **Step 2: Run** `npx vitest run test/unit/engine/forkChats.test.ts test/unit/sessionStore.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the switch to sections:
  - `systemPromptAppend` = `tools.length === 0 ? undefined : openingPromptOf(context.prompt)`.
  - The opening `chatContext` = `[session.hasPrompt ? chatPartOf(session.context.prompt) : undefined, host.chatWideContextOf(...)]`, filtered and joined with `'\n\n'`, as today.
  - `guidanceDiffers` → `promptsDiffer`.
  - `sendGuidanceChange` uses `promptChangeOf(savedSectionsOf(session.context.prompt), prompt, session.context.prompt)` and `mergePromptChange`.
  - `guidanceHash` = `sectionsHashOf` (the existing `promptHashOf` of `reuse.ts`, which hashes the opening prompt text, stays).
  - `reuse.ts` uses `promptChangeOf(savedOf(entry), context.prompt)`. Add `savedOf(entry)`: it returns `entry.promptSections`, or `[{ id: 'guidance', lines: entry.guidanceLines }]` when only `guidanceLines` exists, or `undefined`.
  - `rememberSession` writes `promptSections` and stops writing `guidanceLines`.
  - Delete the server prompt builder and customization discovery wiring.
  - Port the remaining tests that assert the old intro or the `workspace rules:` prefix to sections. Do not delete a test that guards cache behaviour; port it.
  - Update the module list in `boundaries.test.ts` (`systemPrompt` → `promptSections`).

- [ ] **Step 4: Run** `npm run typecheck` and `npx vitest run test/unit/engine test/unit/sessionStore.test.ts test/unit/assemble.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** Tasks 2 and 3 together: `refactor(engine): sessions open with the client's prompt sections; API version 2`.

---

### Task 4: Adapters lose client text; the tool server becomes `hub`

**Files:**
- Create: `src/core/toolServer.ts` with `export const TOOL_SERVER_NAME = 'hub';` and `export const AGENT_BASE_IDENTITY = 'You are a coding agent working in the user\'s workspace.';`
- Delete: `src/core/hostIdentity.ts`
- Modify: `src/core/adapter.ts` (remove `systemPrompt` from `AgentAdapter`)
- Modify: `src/adapters/claude.ts` (`allowedTools` → `` [`mcp__${TOOL_SERVER_NAME}__*`] ``; replace-on fallback; remove `systemPrompt`)
- Modify: `src/adapters/codex.ts` (the base-instructions file holds `AGENT_BASE_IDENTITY`; remove `systemPrompt`; fix comments citing `mcp__vscode__`)
- Modify: `src/adapters/codexHome.ts` (`[mcp_servers.hub]`)
- Modify: `src/adapters/google.ts` (`agent.md` body with replace on → `AGENT_BASE_IDENTITY`; `BUILT_IN_TOOLS_OFF` → `` `mcp_hub_*` ``; frontmatter description → `'Created by ACP Hub to run chats on the client\'s own tools.'`; remove `systemPrompt`)
- Modify: `src/adapters/generic.ts` (remove `systemPrompt`)
- Modify: `src/engine/chat/warmSession.ts:14` and `src/engine/mcp/bridge.ts:506` (use `TOOL_SERVER_NAME`)
- Test: `test/unit/adapters/{claude,codex,codexHome,google}.test.ts`, `test/unit/warmSession.test.ts`, `test/unit/engine/boundaries.test.ts`, the other fakes that set `systemPrompt:` (grep `test/` for `toolAccess`)

**Interfaces:**
- Produces: `TOOL_SERVER_NAME` and `AGENT_BASE_IDENTITY` from `src/core/toolServer.ts`. Task 6 imports `TOOL_SERVER_NAME`.

- [ ] **Step 1: Write the failing tests:**
  - claude: `allows only the hub tools` (`allowedTools` equals `['mcp__hub__*']`).
  - claude: `replaces the prompt with no client text when a request has no prompt`. With replace on and no append, `_meta.systemPrompt` is `''`, or `AGENT_BASE_IDENTITY` if Step 3's check finds the SDK falls back to the preset on `''`.
  - codexHome: `points the timeout at the hub server` (the file contains `[mcp_servers.hub]` and not `vscode`), and `rewrites a managed file written for the vscode server`.
  - codex: `writes a base identity that names no client` (the file equals `AGENT_BASE_IDENTITY`).
  - google: `writes the base identity when the prompt is replaced`; `turns built-in tools off in favour of the hub tools` (the append contains `` `mcp_hub_*` ``).
  - warmSession: `names the tool server hub`.
  - Add to `boundaries.test.ts` the test `writes no client words into the prompt path`. It reads these files, skips lines that start with `//`, `*` or `/*` after trimming, and expects no match for `/VS Code|Visual Studio|Copilot|Microsoft|['"`]vscode['"`]|mcp_+vscode|mcp_servers\.vscode/`. The files are:
    - `src/engine/chat/{ChatService,promptSections,assemble,reuse,keys,sessionStore,warmSession}.ts`
    - `src/engine/mcp/bridge.ts`
    - `src/adapters/{claude,codex,codexHome,google,generic}.ts`
    - `src/hosts/http/{host,wire}.ts`
    - `src/composition/headless.ts`
    - `src/core/toolServer.ts`

    The pattern is case-sensitive on purpose: it lets through `--vscode-*` CSS variables and the on-disk agent id `acp-hub-copilot`, which stays.

- [ ] **Step 2: Run** `npx vitest run test/unit/adapters test/unit/warmSession.test.ts test/unit/engine/boundaries.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Before choosing the Claude fallback, look at how the installed Claude ACP adapter reads `_meta.systemPrompt`: find its `systemPrompt` handling under the agent install (`~/.acp-hub/agents/claude/`). If an empty string is treated as "no prompt" and falls back to the Claude Code preset, use `AGENT_BASE_IDENTITY`. Say which one you chose in the commit message.

- [ ] **Step 4: Run** the same command plus `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `refactor(adapters): no client text; tool server renamed to hub`.

---

### Task 5: Registry carries tool naming; setting descriptions

**Files:**
- Modify: `registry/agents.json`
  - claude and codex get `"mcpToolName": "mcp__{server}__{tool}"`;
  - google gets `"mcpToolName": "mcp_{server}_{tool}", "listRequiredArguments": true`;
  - the three `replaceSystemPrompt` descriptions change.
- Modify: `src/core/vendors.ts` (`RegistryAgent`: `mcpToolName?: string; listRequiredArguments?: boolean`)
- Generated: `package.json` via `npm run generate`

**Interfaces:**
- Produces: `RegistryAgent.mcpToolName` and `RegistryAgent.listRequiredArguments`, which Task 6 reads.

Exact description text (it is server-side text, so it names no client):
- Claude: `On: Claude's built-in Claude Code prompt is replaced by the system prompt the client sends for the chat. Off: the client's prompt is added to the end of the Claude Code prompt. Changing it restarts the agent.`
- Codex: `On: Codex's built-in instructions, bundled skills and environment notes are replaced by a one-line base identity, with the client's system prompt for the chat after it. Off: the client's prompt is added to Codex's own instructions. Changing it restarts the agent.`
- Google: `On: the chat's agent takes a neutral base identity instead of Antigravity's persona, with the client's system prompt for the chat after it. Off: it keeps a short Antigravity persona, with the same prompt after it. Antigravity's own generated prompt is replaced either way; its sections about skills, artifacts and messaging stay. Warning: Google answers a prompt it does not accept with a 429 (Resource exhausted) on every request; if chats fail that way with this on, turn it off. Changing it restarts the agent.`

- [ ] **Step 1: Edit** the registry and the type.
- [ ] **Step 2: Run** `npm run generate`, then `npm run generate:check` and `npm run typecheck`. Expected: PASS, with `package.json` updated for the Claude and Codex descriptions.
- [ ] **Step 3: Commit** `feat(registry): tool naming per agent; neutral replace descriptions`.

---

### Task 6: The extension builds the Copilot prompt

**Files:**
- Move: `src/core/identityPatterns.ts` → `src/hosts/vscode/identityPatterns.ts`
- Move: `src/core/customizations.ts` → `src/hosts/vscode/customizations.ts` (`test/unit/customizations.test.ts` updates its import)
- Modify: `src/hosts/vscode/identity.ts` (`systemGuidanceOf(messages, options?: { keepIdentity?: boolean })`; `chatContextOf` follows)
- Create: `src/hosts/vscode/promptSections.ts`
- Create: `src/hosts/vscode/promptFiles.ts`
- Modify: `src/hosts/vscode/requestMapping.ts` (`bodyOf`)
- Modify: `src/hosts/vscode/serverProvider.ts` (deps and the call at line ~99)
- Modify: `src/hosts/vscode/serverLink.ts` (drop `promptsDir` and `ACP_HUB_PROMPTS_DIR`), `src/extension.ts:93-106` (build `PromptFiles` with the prompts folder; pass `config` and `PromptFiles` to each `ServerProvider`)
- Modify: `test/unit/engine/boundaries.test.ts` (extend the Copilot-format check)
- Test: `test/unit/promptSections.test.ts` (new; takes over the cases of the deleted `systemPrompt.test.ts`), `test/unit/requestMapping.test.ts`, `test/unit/identity.test.ts`

**Interfaces:**
- Consumes: `AcpPromptSection` (Task 2), `TOOL_SERVER_NAME` (Task 4), `RegistryAgent.mcpToolName` and `listRequiredArguments` (Task 5).
- Produces (in `src/hosts/vscode/promptSections.ts`):
  - `copilotSections(guidance: string | undefined): AcpPromptSection[]`. It gives:
    - `guidance`: the rest of Copilot's prompt;
    - `mode:<name>` labelled `<name> mode`: the line matching `^You are currently running in "(.+)" mode\.` plus every `<modeInstructions>…</modeInstructions>` block;
    - `chat` (kind `chat`): the `<session_context>` blocks, then the lines matching `session-state\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`, joined with `'\n\n'`.

    Sections come in that order and empty ones are dropped; runs of three or more newlines collapse to two, then trim, as `splitChatGuidance` does.
  - `notesSection(agentId: string): AcpPromptSection` gives `{ id: 'notes', kind: 'fixed', text }`. The text is today's first intro paragraph: `HOST_IDENTITY` (move the constant here as `HOST_IDENTITY`), then the tool-access sentence, then the mid-tool-message sentences. The tool-access sentence reads ``The tools whose names start with `<prefix>` are VS Code's own and act on the user's workspace.``, where `<prefix>` is `mcpToolName` with `{server}` set to `TOOL_SERVER_NAME` and `{tool}` removed. An agent with no `mcpToolName` gets ``The tools of the MCP server named `hub` are VS Code's own and act on the user's workspace.``
  - `instructionFilesSection(files: readonly CustomFile[], guidance: string | undefined): AcpPromptSection | undefined` is `customFilesSections` and its `namesFile` scan, ported unchanged (same titles, intros and 10,000-character budget), as `{ id: 'instruction-files', kind: 'fixed', text }`.
  - `toolArgumentsSection(tools: readonly { name: string; inputSchema?: unknown }[]): AcpPromptSection | undefined` is `toolArgumentsSection` with `requiredArguments`, ported unchanged (same header, sorted, 4,000-character budget), as `{ id: 'tool-arguments', kind: 'fixed', text }`.
  - `promptSectionsOf(input: { agentId: string; guidance: string | undefined; files: readonly CustomFile[]; tools: readonly { name: string; inputSchema?: unknown }[] }): AcpPromptSection[] | undefined`. It returns `undefined` when the guidance gives no sections and there are no files or tool arguments; otherwise notes, Copilot sections without `chat`, instruction files, tool arguments (only when the registry sets `listRequiredArguments`), then `chat`.
  - `registryAgentOf(agentId: string): RegistryAgent | undefined` matches `agent.id === agentId` or `agentId.startsWith(`${agent.id}-`)`.
  - `replaceSystemPromptOf(config: ConfigReader, agentId: string): boolean` reads `settingKey(<type id>, 'replaceSystemPrompt')` and is true only for the boolean `true`.
- Produces (in `src/hosts/vscode/promptFiles.ts`): `class PromptFiles { constructor(deps: { home: string; profilePromptsDir: string; windowFolders(): readonly string[]; trusted(): boolean; locations(): CustomizationSources['locations']; now?(): number }); get(chatFolders: readonly string[] | undefined): Promise<readonly CustomFile[]> }`.
  - Folders are `chatFolders` when non-empty, else `windowFolders()`. They are `[]` when not trusted, but the home and profile folders are still read, as `discoverCustomizations` does with empty workspace folders.
  - The result is cached per folder list for 5 seconds, so a file added or removed shows up within 5 s and identical inputs give identical bytes.
  - `locations()` reads `chat.instructionsFilesLocations` and `chat.promptFilesLocations`.
- Changes `bodyOf(model, agentId, messages, options, windowFolder, prompt: { replace: boolean; files: readonly CustomFile[] })`. It sends `acp.systemPrompt = { sections }` and no longer sends `systemGuidance`. The guidance is `systemGuidanceOf(messages, { keepIdentity: prompt.replace })`.
- `ServerProviderDeps` gains `readonly prompt: { replace(agentId: string): boolean; files(chatFolders: readonly string[] | undefined): Promise<readonly CustomFile[]> }`. The provider awaits `files(workspaceFoldersOf(messages))` before calling `bodyOf`.

- [ ] **Step 1: Write the failing tests** in `test/unit/promptSections.test.ts` and `requestMapping.test.ts`:
  - `keeps Copilot's identity and content policy when the prompt is replaced`: the guidance holds `You are an expert AI programming assistant`, `Your name is GitHub Copilot.` and `Follow Microsoft content policies.`. With `replace: true`, all three are in `sections`; with `false`, none is, and the `<environment_context>` and the skill list are kept.
  - `adds the tool notes in both modes`: the `notes` section contains `mcp__hub__` for `claude`, `mcp_hub_` for `google`, and the mid-tool sentence (`VS Code adds that note`).
  - `gives two chats identical sections apart from the chat section` (both modes, `claude` and `google`): the guidance differs only in `<session_context>Session folder: …/session-state/<uuid>…</session_context>`. Sections other than `chat` are deep-equal, and `chat` holds each one's block.
  - `splits the mode into a labelled section after the guidance`: a guidance with `You are currently running in "Agent" mode.` and `<modeInstructions>x</modeInstructions>` gives a section `{ id: 'mode:Agent', label: 'Agent mode' }` right after `guidance`, and `guidance` no longer holds either. (Review Focus 1: with no mode line there is no `mode:` section.)
  - `lists required tool arguments only for an agent that needs them, in name order`: shuffled tools give identical text for `google`, and there is no `tool-arguments` section for `claude`.
  - `marks notes, instruction files and tool arguments as fixed`.
  - `reads the replace setting of the agent type for an extra account` (Review Focus 5): config `{ 'agents.claude.replaceSystemPrompt': true }` gives `replaceSystemPromptOf(config, 'claude-work')` = true, and `registryAgentOf('claude-work').id` = `'claude'`.
  - `treats a missing or non-boolean replace setting as off` (Review Focus 4): `undefined` and `'yes'` both give false.
  - `PromptFiles`: `serves the same files within five seconds and rescans after` (a fake `now`); `reads no workspace folder when the workspace is not trusted`.
  - Port the cases from `systemPrompt.test.ts`: the budgets, "does not repeat a file the guidance already names", "lists the instruction files in a fixed order", and "is identical for identical input".
  - `requestMapping.test.ts`: `sends the prompt as sections and no systemGuidance`.
  - Extend the boundary test `knows nothing of Copilot's prompt format` so `hostKnowledge` also matches `session_context|modeInstructions|session-state|currently running in`, checked over `src/engine`, `src/adapters`, `src/hosts/http` and `src/composition`, except `src/engine/chat/messages.ts`. That file is the follow-up project named in the spec; put a comment on the exclusion that names the spec's Open questions.

- [ ] **Step 2: Run** `npx vitest run test/unit/promptSections.test.ts test/unit/requestMapping.test.ts test/unit/identity.test.ts test/unit/customizations.test.ts test/unit/engine/boundaries.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the modules and the wiring.
  - `extension.ts` builds one `PromptFiles`:
    - `home` = `os.homedir()`;
    - `profilePromptsDir` = the path it passes to `ServerLink` today;
    - `windowFolders` from `vscode.workspace.workspaceFolders`;
    - `trusted` = `vscode.workspace.isTrusted`;
    - `locations` from `vscode.workspace.getConfiguration('chat')`.
  - It passes `prompt: { replace: id => replaceSystemPromptOf(config, id), files: folders => promptFiles.get(folders) }` to every `ServerProvider`, including account providers.

- [ ] **Step 4: Run** the same command, plus `npm run typecheck`, `npm run lint` and the full `npx vitest run`. Expected: PASS. `test/unit/sidebarRelay.test.ts` "delivers the state and then every pushed change" is known to be flaky under full-suite load: re-run it alone before treating it as a failure, and name it in the report either way.

- [ ] **Step 5: Commit** `feat(vscode): the extension builds the Copilot system prompt as sections`.

---

### Task 7: Documentation and live check

**Files:**
- Modify: `README.md` (how the extension builds the prompt in each mode; Google with replace on sends Copilot's prompt as it is and Google answers 429, so keep it off; tools are now `mcp__hub__*`)
- Modify: `CHANGELOG.md` (an Unreleased entry: the server writes no prompt text; the tool server is renamed to `hub`; API version 2; a one-time cache miss for chats open or saved at install)
- Modify: `docs/superpowers/specs/2026-11-22-client-owned-system-prompt-design.md` (Status → implemented)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Build** with `npm run typecheck`, `npm run lint` and the project's package/build script, then install the build in VS Code and run the spec's live check:
  - two new Claude chats log the same `Session prompt hash`, and the second reads it from cache;
  - Claude reload, fork and edit read from cache;
  - Codex and Google reloads read from cache;
  - Google with replace off answers (no 429).
  Record what you saw, with log lines.
- [ ] **Step 3: Commit** `docs: client-owned system prompt`.
