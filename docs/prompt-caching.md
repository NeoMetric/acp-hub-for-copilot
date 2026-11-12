# Prompt caching across chats

A new chat should read the start of its prompt from the model's cache instead of paying for it again. This page records what makes that work, what was measured for each agent, and what is outside the hub's control.

## What the hub controls

The session prompt leads the conversation, so one changed character in it makes the cache miss for everything after it. Copilot writes the id of the chat's session folder into its system prompt (`<session_context>` with `Session folder: …/session-state/<uuid>`). Sending that prompt on unchanged made every new chat start with a different prompt.

`splitChatGuidance` (`src/engine/chat/keys.ts`) now separates that block, and any other line naming the session folder, from the guidance:

- The part every chat shares goes into the session prompt, for all agents.
- The part about this chat goes in the message that opens the session, which follows the cached prompt.
- The tool arguments section of the prompt comes last, so a different set of tools changes only the end of it.
- Each new chat logs `Session prompt hash <hash>`. The same hash for two chats means the prompt is identical.

## Measured result

Two new chats, opened one after the other with a real Copilot system prompt that differed only in the session folder id.

| Agent | Second chat, first model call | Notes |
|---|---|---|
| Claude | 13,422 of 14,274 tokens read from cache (94%) | Before the change: 874. |
| Codex | 0 cached | The prompt text was byte-identical between the two chats. |
| Google | 0 cached | The prompt hash was identical between the chats. |

## What the hub cannot fix

### Codex

The two rollout files of the test showed the same instructions and the same tools, yet the first call of the second chat read nothing from the cache, while the second and third calls of each chat did read their own chat's prefix. The Codex binary sends a `prompt_cache_key` with each request. I could not read its value, so the cause is likely the key being per session, but that is not confirmed. Nothing in the hub sets it.

### Google (Antigravity CLI)

The tools of a chat reach the model with a server name that depends on the server settings the hub hands the CLI. Tool definitions come first in a request, so a name that changes per session would break the cache from the start.

Probe, run against `agy acp` directly with a small MCP server of its own:

- Two sessions with identical server settings (same URL, same bearer token): both got the server name `vscode`.
- A session with a different token: `vscode_<hash>`. The hub gives every session its own token, so every chat gets its own name.
- No session read anything from the cache: 0 tokens in all three, and also none for the second prompt of the same session, whose context shared its first prompt's start. The probe could therefore not show that identical names would give cross-session hits.

Giving every session identical server settings would mean the tool bridge (`src/engine/mcp/bridge.ts`) could no longer tell chats apart by token, which is also the isolation between chats. That is a large change with no measured benefit, so it was not made. Revisit it only if a later CLI version shows cache hits for sessions with identical tools.

### Forks

Forking a session in Codex or Google does not keep the cache either, as the CLIs add their own session or connection id. That is the CLIs' behaviour, not the hub's.

## Other limits

- The default cache lifetime at Anthropic is 5 minutes, so a chat started after a longer gap pays a cold write whatever the prompt is. The Claude CLI recognises `ENABLE_PROMPT_CACHING_1H` for a one-hour lifetime; it has not been tried with the hub.
- Anything else in the prompt that changes between chats (skills, instruction files, settings, the date) also misses the cache.
