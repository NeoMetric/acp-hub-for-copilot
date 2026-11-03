# Changelog

## Unreleased

- Show a clear message when Node.js or npm is missing, explaining that Node.js is required for the ACP adapters.
- Show download progress (packages fetched) and a determinate progress bar while installing Claude and Codex.
- Add a Codex "ChatGPT account (code, any browser)" sign-in that shows the page URL and one-time code in the sidebar, with Copy URL and Open in browser, so it works in any browser profile.
- Refresh and show usage right after a successful sign-in, clearing the stale "Authentication required" error.

## 0.0.1

Initial release of ACP Hub for Copilot.

- Use Claude, Codex, and Antigravity agents in GitHub Copilot Chat through ACP adapters.
- Install, sign in to, and configure agents from the sidebar.
- View available usage limits and cache hit rates.
- Authenticate using supported provider accounts or API keys.
