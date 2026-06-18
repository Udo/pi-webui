# Agent Guidelines for pi-webui

## Project overview

This is a full-stack web UI for the Pi coding agent. The server runs a real Pi `AgentSession` with system-level tools (bash, file I/O, extensions). The client is a Lit-based SPA using `@mariozechner/pi-web-ui` components. They communicate over a JSON WebSocket protocol defined in `shared/protocol.ts`.

## Key conventions

- **No client framework beyond Lit templates** — the app uses module-level state plus plain Lit `html` templates in `client/main.ts`; call `renderApp()` after state mutation.
- **Pi SDK types** come from `@mariozechner/pi-coding-agent` (server) and `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` (shared types). Do not duplicate SDK types — import them.
- **Protocol changes** must update `shared/protocol.ts` (the `ClientMessage` and `ServerMessage` unions), the server handler in `handleClientMessage()`, and the client handler in `handleServerMessage()`.
- **CSS** uses Tailwind utility classes in Lit templates plus custom CSS in `client/app.css`. Theme variables come from `@mariozechner/pi-web-ui/app.css` — override them in `app.css` `:root` / `.dark` blocks.
- The sidebar uses plain CSS transitions. Desktop uses `position: relative` with width animation; mobile uses `position: fixed` with transform.

## Runtime and security posture

- The agent session defaults to `os.homedir()`. This is passed as `cwd` to `createAgentSession` and `SessionManager.create()`.
- The WebSocket endpoint controls a real coding agent. Treat any reachable instance as remote-code-execution access for the server user.
- `HOST=127.0.0.1` is the safe default. Bind `HOST=0.0.0.0` only on a trusted network and preferably with `PI_WEBUI_TOKEN` set.
- `PI_WEBUI_TOKEN` is optional. If set, open `/?token=<token>` once; the client persists it in local storage. If unset, WebSocket access relies on Origin checks.
- Do not add hosted CI/CD, deploy hooks, scheduled jobs, webhooks, or other external automation unless explicitly requested.

## Build and run

- `npm run dev` — concurrent dev server (tsx watch + vite)
- `npm run build` — Vite production build to `dist/`
- `npm start` — run production server (serves `dist/` static files)
- Typical local command: `HOST=127.0.0.1 PORT=3001 npm start`

## After making changes

1. Run `npx tsc --noEmit`.
2. Run `npm run build`.
3. If validating a running production server, restart that server because it serves built `dist/` output.
4. Before pushing to a public remote, check for secrets, private hostnames/IPs, local-only docs, and hosted automation configs.

## File layout

- `server/index.ts` — backend (Express, authenticated/origin-checked WebSocket, per-client Pi SDK sessions, optional LiteLLM integration, session management)
- `client/main.ts` — frontend (WebSocket client, state management, UI rendering)
- `client/app.css` — theme overrides, font rules, sidebar CSS, session item styles
- `shared/protocol.ts` — WebSocket message types shared between client and server
- `vite.config.ts` — Vite config with Tailwind plugin and dev proxy for `/api/ws`

## Things to watch out for

- The `pi-web-ui` custom elements (`message-list`, `message-editor`, `streaming-message-container`) must be imported and referenced with `void` to prevent tree-shaking.
- `client/main.ts` locally overrides `AssistantMessage.prototype.render` to append response metadata. Re-audit that copy after `pi-web-ui` updates, especially around chunk/tool rendering.
- `AgentSessionEvent` objects may contain circular references — the server uses `safeSerializeEvent()` before sending them over WebSocket.
- Express 5 uses `path-to-regexp` v8, which requires `/{*path}` syntax for catch-all routes, not `*`.
- The model dropdown uses `position: fixed` with `z-index: 200` to escape stacking contexts.
- Session state is per WebSocket. Avoid debug clients that mutate sessions unexpectedly while someone is actively using the UI.
