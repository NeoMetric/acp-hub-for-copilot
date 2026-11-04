# Changelog

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
