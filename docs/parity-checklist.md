# Manual parity checklist

Run for each of Claude, Codex, and Google, comparing against the old extension on the same machine with both installed.

- [ ] Sidebar: install the agent from the card; progress shown; card flips to installed.
- [ ] Sign in with each supported method (Claude: auto/API key/OAuth; Codex: API key and ChatGPT login; Google: API key). Removing a saved API key works; browser accounts are signed out through the agent's own tools.
- [ ] Agent appears in the Copilot model picker under its own group; model list and effort variants match the old extension.
- [ ] Plain chat reply streams; multi-turn keeps context; cancel stops the turn.
- [ ] Tool use: Copilot tool call round trip (read file, edit file, terminal) works as in the old extension.
- [ ] Long chat: session reuse and fork on edited history behave as before; Google: expired session rebuilds from transcript.
- [ ] Idle: process exits after the idle timeout; next message restarts it.
- [ ] Usage: Claude 5h + weekly + cache ratio; Codex rate limits; Google quota windows grouped by model family.
- [ ] Settings changes in the sidebar take effect (authPreference, timeouts, Codex maxContextWindow, Google command/args).
- [ ] Failure modes: wrong API key, offline install, kill the agent process mid-reply: readable error, next message works.
- [ ] Windows path with spaces/non-ASCII as workspace folder.
- [ ] Old and new extensions installed together: no setting or vendor collisions.
- [ ] Reload window: no orphan server left (Task Manager); the next request attaches to or starts one again.

## Server lifecycle

Run these with the built extension (`npm run compile`, then `npx vsce package` and install the VSIX), on a machine with no server running to begin with.

- [ ] **Server first.** Start `node dist/server.js` by hand on port 8791, then open VS Code: the "ACP Hub" output says the window attached, the three providers list their models, and closing VS Code leaves the server running (`Get-Process node` still lists it; `curl http://127.0.0.1:8791/health` still answers with `name: acp-hub`). Stop it by hand.
- [ ] **VS Code first.** With no server running, open VS Code: the server process it starts carries `--exit-with-parent`, and closing the window makes it disappear within 5 seconds. Repeat, ending the window's extension host with `Stop-Process -Id <pid>`: the server exits too.
- [ ] **Two windows.** Window 1 starts the server and window 2 attaches to it. Close window 1, then send a message in window 2: the first reply fails with a readable error or succeeds after takeover, the next one succeeds, and exactly one server process is left running.
- [ ] **Hostile port.** Occupy 8791 (`python -m http.server 8791`) before opening VS Code: the providers say the server is not compatible and the other process is left untouched. Delete `server.token` while a token-protected server runs: the providers name the token file.
- [ ] **Non-ASCII path.** Open a workspace whose folder has spaces and a non-ASCII character (`C:\Users\Ünal Ö\my repo`): a chat turn works and the agent's working directory is that folder.

## Known losses

Deliberate differences from the in-host extension; do not count them as regressions.

- A window regaining focus no longer wakes an agent the idle shutdown stopped; the next message starts it.
- The "Dump requests" setting writes its files on the server, in `<root>/agents/<id>/requests`, not in the extension's storage folder.
- Sign-in no longer offers a VS Code quick pick: the server shows a page URL to open, or the command to run in a terminal.

The adapter contract is machine-checked: `test/unit/adapters/conformance.test.ts` runs every adapter in `ADAPTERS` against it, so a new adapter must declare a session policy or inherit `nativeSessionPolicy`.
