# Changelog

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
