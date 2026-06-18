# Code Review — pi-webui

Status: implemented in this fork.

## Implemented

- WebSocket `Origin` validation for `/api/ws`.
- WebSocket shared-secret authentication via `PI_WEBUI_TOKEN` / `?token=...`.
- WebSocket max payload cap and client message shape/size validation.
- Per-WebSocket `AgentSession` isolation so one browser/debug client cannot switch another client's session.
- Disconnect cleanup now unsubscribes and aborts an in-flight session.
- Client reconnect stores/reuses the current session path and can resume via `loadSession`.
- Error banner timer is de-duplicated so older timers do not clear newer messages.
- Client WebSocket message parsing is guarded with `try/catch`.
- Env integer parsing has finite fallbacks.
- Sessions sidebar is limited/cached and refreshed when the active session changes.
- Streaming and loaded-session views scroll to the bottom.
- README/AGENTS deployment notes were updated for the local aiworker evaluation setup.

## Remaining low-priority notes

- `safeSerializeEvent()` still defensively `JSON.stringify`/`JSON.parse`s agent events before the outer send serializes them. This is retained because upstream notes mention circular event objects; optimizing it needs a careful event-shape audit.
- `prompt` remains intentionally fire-and-forget while `steer`/`followUp` are awaited. This matches the desired behavior where prompts stream asynchronously and later actions report immediate command errors.
- Static HTML is still publicly fetchable; the RCE path (`/api/ws`) is origin-checked and token-gated.
