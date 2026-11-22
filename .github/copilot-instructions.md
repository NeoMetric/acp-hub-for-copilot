# Repository instructions

## The server stays client-neutral

This rule is final. Do not bend it, work around it, or add "temporary" exceptions.

The server must hold zero knowledge of any client. It must not know VS Code, Copilot, or any client that comes later. The server is everything bundled into `dist/server.js` (see `esbuild.js`): `src/main`, `src/composition`, `src/engine`, `src/adapters`, `src/hosts/http`, and every file of `src/core` they import.

In that code, never add:

- text written for the model that names or assumes a client: identities ("running inside VS Code"), content rules ("Follow Microsoft content policies"), notes about how the client runs tools;
- parsing of a client's tags or prompt structure, such as `<session_context>`, `<modeInstructions>`, `<userRequest>`, or `session-state/` paths;
- a client's file conventions, such as `.github/instructions` or `*.prompt.md`;
- names taken from a client, such as an MCP server called `vscode`;
- branches that treat one client, or one client-and-agent pair, differently.

The system prompt and everything injected into it are the client's responsibility. The client sends the prompt; the server applies it through each agent's own mechanism and writes no text of its own.

Client-specific code lives only under that client's host folder. For VS Code that is `src/hosts/vscode`, bundled into `dist/extension.js`.

Agent knowledge is not client knowledge. How an agent names tools, takes a system prompt or reports usage belongs in `src/adapters` and `registry/agents.json`, written so that it holds for any client.

If a change seems to need client knowledge in the server, put it in the client instead. If the server has to carry something, make it a neutral field of the wire contract (`src/hosts/http/wire.ts`) that the client fills in.

The design behind this rule is `docs/superpowers/specs/2026-11-22-client-owned-system-prompt-design.md`.
