# Changelog

## Unreleased

- Fix, for the Google agent only (Claude and Codex are unchanged), editing an earlier message (or resuming a chat) missing the prompt cache for the whole conversation when Copilot's guidance had changed in between, even by one line. The session prompt is rebuilt from that guidance and leads the conversation, so the agent saw a different first token and re-read everything uncached (the log showed `0 cached` for the first turn after the fork). The extension now keeps the prompt each saved session began with, in its storage folder, and sends that same text when it resumes or forks the session; what changed in the guidance still reaches the agent as a message. Prompts unused for 14 days are removed. Chats saved before this change have no stored prompt, so their first edit can still miss. Switching to a mode that adds a tool (such as Autopilot's `task_complete`) still misses once, because the tool declarations come before the conversation in the model request.
- Fix the first message to Codex waiting several seconds, up to 18 in one window, after the agent was stopped for being idle. On start Codex refreshes its model catalog and checks the account with ChatGPT before it answers the adapter's account read, which every new session waits for; a connection that stalls holds that up for 5 seconds or more. An agent the idle shutdown stopped now starts again, with its warm session, as soon as the window is in use again, so the start runs while you type.
- Run the Google agent on the Antigravity CLI's own ACP server (`agy acp`) instead of the separate Antigravity ACP server. It uses the same model backend as the official Antigravity extension, so turns are about as fast: the same eight-step test went from about 2 minutes 14 seconds to about 50 seconds (51 seconds in the official extension). The extension downloads the CLI, checks it against Google's published SHA-512, and fetches the new version unasked after an extension update; the old server's files are removed. Chats started on the old server continue from their transcript once.
- Fix the thinking level of the model picker not controlling the Google agent: on the old server even Low thought for thousands of tokens on some steps. Low now does no extended thinking, and a reopened chat gets its level back.
- Fix the first turn of an edited or forked Google chat missing the prompt cache. Antigravity writes the conversation id into its system prompt, so a copy under a new id could not reuse it. The fork now keeps the source's id: the whole conversation is copied for the original chat, which continues there, and the source is rewound to the fork point without touching workspace files. The agent is restarted at the fork, which is when it re-reads the conversation; opening a Google chat or resuming one after a window reload stays at a few milliseconds. A fork taken while another Google chat is in the middle of a turn keeps an id of its own instead of restarting the agent, so that fork's first turn misses the cache once.
- Stop a terminal window flashing open while the extension loads, on Windows. The Google quota is read through a language server that `agy --hub` starts, and the process that server runs in opens a console window of its own, which Windows Terminal shows for as long as the read lasts, whatever the extension asks of the process. The quota is now read only when asked for (the Refresh usage button, or after signing in) instead of at startup and after every turn. Forking a Google chat still starts that server for a few seconds.
- Make forking a Google chat survive the CLI's language server not being ready: it sometimes answered the copy or the rewind with `failed to clone trajectory` or `unknown model key …`, which made the chat fall back to a transcript in a new session (a full cache miss). Those answers are now retried a few times, and a copy made for a fork that then failed is deleted instead of piling up in the CLI's history. Measured on the CLI (1.5.3): after a fork the first model call of the chat that keeps the id still sends the earlier turns' history uncached (the CLI re-renders a rewound conversation), so a fork's first turn cached about 45–60% on a long chat and the next calls about 96%; that part is the CLI's.
- Turn Antigravity's own tools off for real, instead of asking the model not to use them. The CLI ignores the agent's `disabledTools` and the `_meta` options for this, but the custom agent file it loads honours a `tools` allowlist, so the extension now runs `agy acp --agent=acp-hub-copilot` with `tools: []` whenever the built-in tools are off (the default). In a real chat the CLI then offered only the chat's own tools, `list_resources` and `read_resource` — no `run_command`, `read_file`, `write_file` or `edit_file` — and the first request carries about 4,700 fewer tokens. "Use the agent's built-in tools" still runs Antigravity's own agent with all of its tools.
- Add the "Replace the Antigravity system prompt" toggle to the Google agent card, like the one Claude and Codex have. Antigravity generates its prompt, and a custom agent replaces its identity section rather than sitting beside it, so the agent keeps a short Antigravity persona when the toggle is off and takes Copilot's identity when it is on; Copilot's guidance follows either way, and the sections about skills, artifacts and messaging stay. The agent file lives in the CLI's global agents folder (`~/.gemini/agents/acp-hub-copilot/agent.md`) and appears in its agent list; forking and its prompt-cache hits are unchanged.
- Fix the Google agent's context figure in the chat's session info, which grew with every tool call: `agy acp` sends no `usage_update` and reports only the sums of a whole turn, and every model call of a turn sends the whole conversation again, so a turn of three calls showed about 76K tokens for a 26K context and a long turn reached 352K. The extension now reads the tokens of the last model call from the CLI's own record of the conversation (`<gemini home>/antigravity-copilot/brain/<session>/.system_generated/logs/transcript.jsonl`, which carries `input_tokens` and `cache_read_tokens` per call) and reports that as the context, with its cached share. Agents that do send `usage_update` are unchanged.
- Show the Google agent's cache hit rate, which the CLI reports.
- Read the Google quota from the Antigravity CLI instead of asking the agent for `/usage`.
- Remove the "Antigravity CLI (agy)" setting: edits, `/fork` and side chats now use the CLI the agent runs. The "Agent command" setting now points at an Antigravity CLI.

## 0.0.6

- Continue edited and forked chats from a saved conversation checkpoint when the agent supports it. Antigravity requires the separately installed Antigravity CLI; otherwise the chat is rebuilt from its transcript.
- Fix Antigravity taking minutes over a few steps of a turn. The agent saves a tool result of about 4,000 characters or more, such as a file read in full, to a file and hands the model only the path. With its own file tools off, the model then reasoned for 4,000 to 20,000 tokens about how to get at the content. Results are now cut to 3,500 characters with a note on how to ask for the rest, and the same eight-step test went from about 3.5 minutes to about 1 minute.
- Fix an answer to a question never reaching Codex. Codex's `exec` tool yielded after 30 seconds, before the user had answered, and the agent went on without reading the answer. It now stays open for up to 30 minutes, and a yield time set in `CODEX_CONFIG` is kept.
- Fix an answer to a question that took longer than 5 minutes being lost with "timed out awaiting tools/call after 300s". Codex now gives a call to the Copilot tools up to 24 hours, set in the `config.toml` of the extension's own Codex home. The extension keeps that file up to date until its first line is removed.
- Fix an answer to a question never reaching Claude when the user took several minutes. Claude Code closes a silent tool notification stream after about 6 minutes and then drops the pending call ("transport dropped mid-call"). The bridge now keeps the stream alive.
- Fix every `/usage` read leaving a Claude Code session behind in `~/.claude/projects`, which filled the session list of tools that read that folder with `/usage` entries. The session that reads usage and the model list is now ephemeral and keeps no transcript. Sessions already left behind are not touched.
- Number the model calls of a turn in the log for agents that report only the turn's cache split, with the context each call sent, and say how many calls the turn's cache figure adds up, so a low-looking cache percentage on a long turn can be traced to its calls.

## 0.0.5

- Add a "Cache misses" counter to each agent card, with the tokens that were billed at full price instead of read from the cache, and a separate count for misses after the chat sat idle longer than the cache lives.
- Fix toggling Copilot's tools, such as Search Tools, rebuilding the chat session and missing the cache. The reminder Copilot adds to the end of a request when tools are deferred is no longer taken as a change to the chat.
- Fix a mode switch leaving the old mode's instructions in force. The agent is now told it has left the mode by name, without repeating its instructions, and other guidance lines that are gone are listed by a short preview. The guidance change sent for a new mode is no longer cut at 8,000 characters.
- Move per-request log lines (requests, tool and guidance changes, session reuse details, usage) from the info to the debug level and drop duplicates, so the log shows what matters.

## 0.0.4

- Fix skill context arriving separately from its tool result being taken as a new message from the user, which ended the running turn and started a new one. The context now goes to the agent with its tool result.
- Show an error in the log when a request fails or the agent fails while waiting for a tool result, instead of staying silent.
- Show a clear "please retry" error when skill context cannot be matched to its tool call, instead of hanging.

## 0.0.3

- Add a "Replace the system prompt" toggle to the Claude and Codex cards (off by default). On, the agent's own prompt is replaced by Copilot's guidance and a one-line identity; Antigravity can only append, so it has no toggle.
- Add a "Tool search" setting to the Claude card (default, on, off). On, Claude loads each Copilot tool's description only when it needs it instead of sending all of them with every request, which makes each request much smaller. Default leaves the behavior as it was.
- Fix request dumps not being written when only the agent's own "Dump requests" setting was on.

## 0.0.2

- Show a clear message when Node.js or npm is missing, explaining that Node.js is required for the ACP adapters.
- Show download progress (packages fetched) and a determinate progress bar while installing Claude and Codex.
- Add a Codex "ChatGPT account (code, any browser)" sign-in that shows the page URL and one-time code in the sidebar, with Copy URL and Open in browser, so it works in any browser profile.
- Show "Finalizing install..." and "Starting the agent..." after the last package downloads, so the install does not look stuck.
- Finish the Claude sign-in and refresh the sidebar as soon as the login completes, without clicking Refresh usage.
- Refresh and show usage right after a successful sign-in, clearing the stale "Authentication required" error.

## 0.0.1

Initial release of ACP Hub for Copilot.

- Use Claude, Codex, and Antigravity agents in GitHub Copilot Chat through ACP adapters.
- Install, sign in to, and configure agents from the sidebar.
- View available usage limits and cache hit rates.
- Authenticate using supported provider accounts or API keys.
