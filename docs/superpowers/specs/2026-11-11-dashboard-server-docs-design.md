# Dashboard: server status header, Server settings, Docs

## Intent
Give the extension user confidence that the dashboard runs from a live local server, let them change the server's port from the dashboard, and document how the server, the VS Code Copilot client and the Copilot CLI fit together.

## Goals
- **Header strip** at the top of every dashboard view: `127.0.0.1:<port>` as a link that opens `http://127.0.0.1:<port>/?token=<token>` in the browser, plus a green "alive" indicator (red/grey when the server is unreachable).
- **Server settings** nav item. Only option for now: the port.
  - Saving writes the port to the server's own config (`config.json`, key `server.port`) through the same global-settings path the dashboard already uses. It does not belong to VS Code settings.
  - It applies on the next server start. A **Restart server** button sits beside the field with a note: restarting ends any existing sessions.
- **Docs** nav item after Usage, every section a collapsible `<details>` block, styled like the existing global-settings block:
  1. **Server**: how it works (one local process serving the dashboard and the model API, bearer token, shared by all windows, idle timeout, detached) and a short list of server-level settings (port, idle timeout, detached, resume/transcript settings).
  2. **VS Code Copilot client**: the settings available in VS Code and `ACP Hub: Sync models`, which syncs the models into Copilot.
  3. **Copilot CLI**: how to make it work: run `ACP Hub: Sync models`, which updates the CLI as well as the VS Code client.

## Non-goals / anti-goals
- No other server settings in Server settings yet.
- No VS Code `acpHub.server.port` setting. The server's config owns the port.
- No automatic restart on save, and no change to the token mechanism.

## Constraints
- The page is host-agnostic (`mountPage` draws what the transport hands it), so address, token link and alive flag travel in `ControlState`. The sidebar and a browser tab share the one implementation.
- Port precedence: `ACP_HUB_PORT` env, then `config.json` `server.port`, then 8791. `serverLink.ts` currently hard-codes 8791 and must read the same value to find and start the server.
- Match the existing UI: `renderNav`/`PageView` in `src/ui/render.ts`, view switching in `src/ui/page.ts`, styles in `media/sidebar.css`.

## Approaches
1. **Add a `server` block to `ControlState` plus new views and actions (chosen).** Fits the architecture and works in both transports.
2. **Webview-only header.** Rejected: the webview can't know the token or the real link state.

The user's decisions: the port lives in the server's config and the dashboard edits it (not a VS Code setting); it applies on restart; the Restart button carries the "ends existing sessions" note.

## Left to the builder
- Exact `ControlState` shape and action names (e.g. `setServerPort`, `restartServer`).
- Port validation (integer 1–65535 in the UI; the server's existing `portOf` is the backstop).
- How "alive" is derived (link state in the window, a live connection in a browser tab).
- What a browser tab shows after a restart (the old address goes away; show the new one when known).
- Docs copy and CSS.
- Tests: unit tests for the render and state changes, following the existing `test/unit` layout.
