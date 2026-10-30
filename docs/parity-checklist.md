# Manual parity checklist

Run for each of Claude, Codex, and Google, comparing against the old extension on the same machine with both installed.

- [ ] Sidebar: install the agent from the card; progress shown; card flips to installed.
- [ ] Sign in with each supported method (Claude: auto/API key/OAuth; Codex: API key and ChatGPT login; Google: API key). Removing a saved API key works; browser accounts are signed out through the agent's own tools.
- [ ] Agent appears in the Copilot model picker under its own group; model list and effort variants match the old extension.
- [ ] Plain chat reply streams; multi-turn keeps context; cancel stops the turn.
- [ ] Tool use: Copilot tool call round trip (read file, edit file, terminal) works as in the old extension.
- [ ] Long chat: session reuse and fork on edited history behave as before; Google: expired session rebuilds from transcript.
- [ ] Idle: process exits after the idle timeout; next message restarts it.
- [ ] Usage: Claude 5h + weekly + cache ratio; Codex rate limits; Google shows "not supported".
- [ ] Settings changes in the sidebar take effect (permissionMode, authPreference, timeouts, Codex maxContextWindow, Google command/args).
- [ ] Failure modes: wrong API key, offline install, kill the agent process mid-reply: readable error, next message works.
- [ ] Windows path with spaces/non-ASCII as workspace folder.
- [ ] Old and new extensions installed together: no setting or vendor collisions.
- [ ] Reload window: no orphan agent processes left (Task Manager).
