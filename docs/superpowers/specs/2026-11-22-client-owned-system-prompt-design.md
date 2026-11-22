# Client-owned system prompt

Date: 2026-11-22
Status: draft, awaiting approval

## Intent

The server is a server. It must hold no knowledge of any client: not VS Code,
not Copilot, not any client that comes later. Today it writes Copilot- and
VS Code-specific text into every agent's system prompt (the host identity, the
"VS Code adds that note" sentence, Microsoft's content rules, the
"Copilot runs a tool…" note) and parses Copilot's tags to keep that prompt
cacheable. The system prompt, and everything injected into it, becomes the
client's responsibility. The server takes the prompt the client sends and
applies it through each agent's own mechanism, writing no text of its own.

The trigger was Google: the server-written line "Follow Microsoft content
policies." makes Google answer every request with a 429. That is fixed as a
side effect, not by special-casing Google.

## Goals

- Zero client-specific text or parsing in the server bundle's prompt path:
  `src/engine`, `src/adapters`, `src/core` as used by the server, `src/hosts/http`.
- The VS Code extension builds the whole prompt, honouring each agent's
  "Replace system prompt" setting:
  - **Replace on**: Copilot's system prompt as it is (identity, persona and
    content policy included), plus the extension's functional notes (below).
  - **Replace off**: the agent keeps its own system prompt; the extension
    appends Copilot's system prompt minus Copilot's identity, persona and
    content-policy lines (what `IDENTITY_PATTERNS` removes today), plus the
    same functional notes.
- Replace off must not be a reduced mode. Everything Copilot needs to work
  through the agent reaches the model in both modes.
- No new cache misses for new sessions. What hits the cache today keeps
  hitting: on Claude, a reloaded window, a forked chat and an edit of an
  earlier message; on Codex and Google, a reload that resumes the session.
- Mid-chat prompt changes (mode switches) keep today's behaviour, sent as a
  message after the cached prefix, with no Copilot knowledge in the server.

## Non-goals

- Making the prompt byte-identical to today's. A one-time miss for sessions
  that are already open or saved when the new version is installed is
  expected and accepted.
- Any Google-specific edit of the prompt. With replace on, Google gets
  Copilot's prompt like every other agent; its setting warns that Google
  rejects it (429) and that replace off is the mode that works.
- The Copilot tag parsing in the per-message path (`src/engine/chat/messages.ts`:
  `<userRequest>`, `<attachments>`, `<context>`, `<editorContext>`,
  `<reminderInstructions>`, `<toolReferences>`, `<system_reminder>`,
  `<ide_selection>`, `<instructions>`, `<modeInstructions>`,
  `<system_notification>`). It is client knowledge in the server too, but it
  is a separate project with its own cache questions; see Open questions.

## Anti-goals

- A change that works but costs more: any new per-chat byte in the opening
  prompt, any non-deterministic ordering, or any path that rewrites a live
  session's opening prompt.
- Removing, for one provider, exactly the sentence that provider checks for.
  Dropping the content-policy lines in replace off is one rule for all agents,
  justified on its own (the agent's own prompt and its provider's policies
  apply); a Google-only removal would be evasion of Google's block.
- Client text creeping back into the server under another name (for example
  a "default host identity" constant in an adapter that names VS Code).

## Constraints and facts the design rests on

- The session prompt is fixed when a session opens. Copilot re-renders its
  system prompt on every request; the server compares it with what the
  session opened with and sends the difference as a message
  (`ChatService.sendGuidanceChange`, `assemble.guidanceChangeBlock`). That
  never touches the cached prefix.
- Cross-chat cache sharing today depends on `splitChatGuidance`
  (`src/engine/chat/keys.ts`): `<session_context>` blocks and lines naming
  `session-state/<uuid>` are moved out of the session prompt into the
  message that opens the session (`ChatService` line ~456, `chatContext`).
  Without that, every new chat would miss on the whole prompt (~12K tokens).
- Codex and Google embed their own session id in their prompts; only a
  resume hits for them. Unchanged by this design.
- `replaceSystemPrompt` lives in the server's `config.json`
  (`acpHub.agents.<id>.replaceSystemPrompt`). The extension already reads that
  file (`serverLink.ts`, `loadConfig`). Claude applies it per session
  (`meta.systemPrompt` string vs `{ append }`); Codex (base instructions file)
  and Google (custom agent `agent.md`) apply it when the process starts, and
  changing it restarts the agent.
- Google keeps a chat's saved prompt on reopen (`keepsSavedPrompt`), so
  Google chats saved under the old prompt keep it. Accepted.
- The extension and the server are separate bundles (`esbuild.js`): the
  extension may import `src/core` and `src/hosts/http/wire.ts`, not
  `src/adapters`.

## Approaches considered

1. **Plain text, server diffs line by line.** The client sends one prompt
   string; the server reports added and removed lines. Simplest, but on a
   mode switch the model gets a capped list of removed lines instead of
   "you left Agent mode": vaguer, so functionality is lost.
2. **Named sections, server diffs by section.** *Chosen.* The client sends
   the prompt as ordered, labelled sections; the server joins them for the
   opening prompt and diffs by section id, retracting a removed section by
   its label in generic wording. Keeps today's mode-switch behaviour with no
   Copilot knowledge in the server, at the cost of a slightly larger request
   format and the extension splitting Copilot's prompt into sections.

Neither affects the cache: change messages follow the cached prefix, and the
opening prompt is deterministic either way. Option 2 was picked because it is
the one that loses nothing on a mode switch.

## Design

### Wire contract (`src/hosts/http/wire.ts`)

`AcpRequestExtras` gains:

```ts
systemPrompt?: {
	sections: Array<{
		id: string;      // stable key the server diffs by, e.g. 'notes', 'guidance', 'mode:Agent'
		label?: string;  // how a removed section is named to the model, e.g. 'Agent mode'
		text: string;
		fixed?: boolean; // used only when a session opens: never diffed mid-chat, not in the guidance hash
	}>;
};
```

- Section order is the byte order of the opening prompt. The server joins the
  texts with a blank line and adds nothing.
- `fixed` reproduces today's split: Copilot's guidance (and its mode) is
  compared on every request and hashed for resume/fork matching; the notes,
  instruction-file pointers and tool arguments are only read when a session
  opens, as the server-built parts are today. So a new workspace file or a
  changed tool set never sends a change message, and resume/fork matching
  is unchanged.
- `chatContext` (existing) carries the per-chat parts as well as the
  chat-wide context; the server forwards it once when a session opens, as now.
- `systemGuidance` (existing) is still accepted, as one unlabelled section
  with id `guidance`, for older clients. A stock OpenAI client's system
  message is treated the same way.
- The server's own `replyRulesOf` (from `response_format` / `tool_choice`) is
  OpenAI-API-generic and stays; it becomes a trailing section `reply-rules`.
- `API_VERSION` goes to 2; the extension requires a server that reports 2.
  (Builder: follow the existing version-check path in `serverLink.ts`.)

### Server (client-neutral)

- `buildSystemPromptAppend` becomes a join of the client's sections: no intro,
  no `HOST_IDENTITY`, no content rules, no tool-arguments section, no
  instruction-file pointers.
- `createSessionPrompt` stops discovering customization files; `discoverCustomizations`
  and its Copilot conventions (`.github/instructions`, `.copilot/prompts`,
  `*.instructions.md`, `*.prompt.md`) leave the server path.
- `splitChatGuidance`, `SESSION_CONTEXT_BLOCK`, `SESSION_FOLDER_ID`,
  `MODE_LINE`, `MODE_BLOCK` and the `session-state/` folding in
  `squashGuidance` leave the server. Case and whitespace folding stay (generic).
- Generic section diff replaces the mode-aware line diff. Only sections not
  marked `fixed` are compared, and only they make up the guidance hash and
  line hashes stored for a saved session:
  - a section id that disappeared: if it has a label, "The "<label>"
    instructions no longer apply."; without a label, today's gone-lines
    preview;
  - a new section id: its text is sent as added, as new lines are today
    (same 40,000-character cap);
  - a section whose text changed: today's line diff within that section;
  - pending changes merge as today; a section removed and re-added before the
    change is sent cancels out (the generalisation of `stillInMode`).
- Saved sessions store per-section ids, labels and line hashes. A record
  saved before this change has none and is read as one unlabelled section,
  so it falls back to today's line diff.
- Adapters:
  - `HOST_IDENTITY` (`src/core/hostIdentity.ts`) is deleted from the server.
  - Claude, replace on, a request with no tools: no client text. Send an
    empty string if the SDK takes it without falling back to the Claude
    Code preset; otherwise a neutral line the adapter owns that names no
    client. (Builder verifies.)
  - Codex, replace on: the base-instructions file holds a neutral line the
    adapter owns, naming no client.
  - Google, replace on: `agent.md` holds a neutral line the adapter owns
    instead of `HOST_IDENTITY`. Replace off keeps `ANTIGRAVITY_PERSONA`.
  - `systemPrompt.toolAccess` and `listRequiredArguments` leave the adapter
    interface; the tool-naming knowledge moves to the registry (below).
- MCP bridge: the tool server gets one fixed, server-owned, neutral name,
  `hub`, for every client. It cannot be chosen per request, because two places
  bind it when a process or session starts: Claude's
  `allowedTools: ['mcp__vscode__*']` (`claude.ts`) and Codex's
  `[mcp_servers.vscode]` entry carrying the 24-hour tool timeout
  (`codexHome.ts`). Every use moves to the one name: `bridgeServer()`
  (`warmSession.ts`), the bridge's `serverInfo.name` (`bridge.ts`), Claude's
  `allowedTools`, the Codex config entry, Google's `BUILT_IN_TOOLS_OFF` text
  and the comments that cite `mcp__vscode__`. Tools then reach the model as
  `mcp__hub__<name>` (Claude, Codex) and `mcp_hub_<name>` (Google).
  - Cache: the tool list changes once at install, the same moment the prompt
    changes, so new sessions after install pay nothing extra.
  - A session saved before the install has calls to `mcp__vscode__*` in its
    history. The builder verifies that such a session still resumes; if the
    agent rejects it, the existing fallback (resume fails, a new session
    starts with the chat restored as a transcript) must kick in cleanly.
- Unchanged: when the prompt is used (session open only), `keepsSavedPrompt`,
  prompt hashing and logging, reuse and fork logic.

### Registry (agent knowledge both bundles read)

Each agent in `registry/agents.json` gains how it names MCP tools and
whether it needs the required-arguments list, for example
`"mcpToolName": "mcp__{server}__{tool}"` (Claude, Codex),
`"mcp_{server}_{tool}"` (Google), and `"listRequiredArguments": true` for
Google. This describes the agent, not the client. Exact field names are left
to the builder; `npm run generate` keeps `package.json` in step.

The Google `replaceSystemPrompt` description gains the warning: with it on,
Copilot's prompt goes through as it is and Google rejects it with a 429;
leave it off to use Google from Copilot. The Claude and Codex descriptions
stop saying "one-line identity" where the server no longer writes one.

### Extension (`src/hosts/vscode`): owns the Copilot prompt

Per request, in `bodyOf()` (`requestMapping.ts`), which knows `agentId`:

1. Read `acpHub.agents.<agentId>.replaceSystemPrompt` from the server config
   on every request (default from the registry). `FileConfig.get` re-reads
   `config.json` when its modification time changes, so a change made on the
   dashboard is seen on the next request; the server reads the same file and
   restarts the agent. A window attached to a server started with another
   config folder can disagree; that is an accepted limitation, logged by
   neither side.
2. Take Copilot's system messages (`systemGuidanceOf`), with
   `[copilot_cache_control:…]` markers removed. Replace off: apply
   `stripIdentity`. Replace on: keep everything.
3. Move the per-chat parts (`<session_context>` blocks, lines naming
   `session-state/<uuid>`) out into `chatContext`, ahead of the chat-wide
   context, exactly as `splitChatGuidance` does today.
4. Split what remains into sections: the mode line and its
   `<modeInstructions>` block as `mode:<name>` labelled `<name> mode`; the
   rest as `guidance`. Sections keep their order in Copilot's prompt.
5. Add the extension's functional notes, in this order around the guidance:
   - `notes` (first): how the tools are named for this agent (from the
     registry's tool-name format and the server's `hub` name), and that a tool result can end
     with a note that the user sent a new message while the tool ran, which is
     their newest message;
   - `instruction-files` (after the guidance): pointers to `*.instructions.md`
     and `*.prompt.md` files Copilot does not already name, as
     `customFilesSections` builds them today. Discovery moves here, using
     `vscode.workspace.isTrusted` and VS Code's own location settings. The
     extension cannot tell when a session opens, so it builds this section
     for every request; the result is cached and rebuilt only when a watched
     instruction or prompt file, a location setting or the workspace trust
     changes;
   - `tool-arguments` (last, only where the registry says so): the required
     arguments per tool, sorted by name, from `options.tools` schemas.
6. Mark `notes`, `instruction-files` and `tool-arguments` as `fixed`, and
   send `systemPrompt.sections` and `chatContext`.

`IDENTITY_PATTERNS` / `stripIdentity`, the content of the notes, and the tag
knowledge above move under `src/hosts/vscode`. The doc comment in
`identity.ts` ("nothing in `src/engine` may name them") now holds for the
system prompt path.

### Cache guarantees and how they are proved

Rules the build must keep:

- **Chat-independent:** two chats that differ only in which chat they are
  produce byte-identical opening prompts.
- **Deterministic:** the same inputs give the same bytes: fixed section order,
  sorted tool lists, no timestamps, no ids.
- **Fixed per session:** the opening prompt is only used when a session opens;
  every later change goes as a message.

Tests (they would fail without the change):

- Extension: for each mode (on/off) and each agent's tool-name format, two
  request fixtures that differ only in session id and session folder give
  identical `sections`, and the per-chat parts land in `chatContext`.
- Extension: shuffled tool order gives identical `tool-arguments` text.
- Extension: replace on keeps Copilot's identity and content-policy lines;
  replace off removes them and keeps everything else, the notes included.
- Server: no output text of the prompt path contains client words. A test
  builds prompts from neutral sections and checks for "VS Code", "Copilot"
  and "Microsoft", and a source grep over the server prompt path guards
  against regressions.
- Server: mode switch `mode:Agent` → `mode:Ask` produces the label
  retraction plus the new section's text, and no gone-lines list for the old
  mode; switching back before the change is sent cancels it.
- Server: a saved session without sections still resumes, with today's
  line-diff fallback.

Live check after install, using the existing "Session prompt hash" log and the
cache figures:

- Two new Claude chats in one workspace log the same prompt hash, and the
  second reads the prompt from cache.
- Claude: reload the window, fork a chat and edit an earlier message; each
  reads from cache as before.
- Codex and Google: reload the window; the resumed session reads from cache.
- Google with replace off: a chat succeeds (no 429).

## Decided in conversation

- Zero client-specific information in the server; the prompt is the client's
  responsibility. Final.
- The extension reads the replace setting; replace on means Copilot's prompt
  as it is plus the functional notes; replace off means the same without
  Copilot's identity, persona and content policy.
- The four additions (tool-naming note, mid-tool message note, instruction
  file pointers, required tool arguments) stay, moved to the extension, in
  both modes.
- Google gets no special treatment; its replace setting carries a warning.
- Named sections with a generic section diff (approach 2).
- One-time misses for sessions open or saved at install time are accepted.

## My calls (check these)

- The section order: notes, then Copilot's guidance (mode in place), then
  instruction-file pointers, then tool arguments, then the server's reply
  rules. That is today's order with the intro replaced by the notes.
- The retraction wording: "The "<label>" instructions no longer apply."
- The tool server is renamed from `vscode` to a fixed neutral `hub` in the
  server, for every client; the miss falls on the same install-time change.
- Sections carry a `fixed` flag so that only Copilot's guidance is diffed and
  hashed, as today.
- The extension reads the replace setting from `config.json` per request;
  a server started with another config folder is an accepted limitation.
- Instruction-file discovery in the extension is cached and rebuilt on file,
  setting or trust changes.
- The tool-naming format and the required-arguments flag go in the registry
  as agent knowledge.
- `API_VERSION` is bumped to 2; `systemGuidance` stays accepted for older
  clients and stock ones.
- Adapter fallbacks under replace on use neutral lines that name no client.

## Left to the builder

- Exact names of the registry fields and new types.
- How the extension finds the profile prompts folder it passes to discovery
  today (`promptsDir`), and VS Code's location settings for instruction and
  prompt files.
- Whether the Claude SDK accepts an empty `systemPrompt` string.
- Where the Google warning shows besides the setting description, if the
  settings UI supports a warning style.
- README and CHANGELOG updates.

## Open questions

- The per-message Copilot parsing in `src/engine/chat/messages.ts` is the
  same kind of client knowledge in the server. It is out of scope here;
  whether it is the next project, and in what order, is for the owner to say.
