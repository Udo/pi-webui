# Code Review — pi-webui

Second-pass review after the hardening changes. Typecheck (`tsc --noEmit`) passes clean.

## Verified fixes (from the prior review)

- **CSWSH / WebSocket `Origin` check** — `verifyClient` validates `Origin` against the `Host`
  header plus a `PI_WEBUI_ALLOWED_ORIGINS` allowlist (`server/index.ts`). Closes the
  browser-driven RCE hole even when no token is set.
- **Application-layer auth** — opt-in `PI_WEBUI_TOKEN`, compared with `timingSafeEqual` plus a
  length guard; startup warns when unset.
- **Reconnect no longer orphans the session** — disconnect aborts an in-flight session; the client
  persists the session path and resumes the selected session on reconnect.
- **Stacked error-clear timers** — `errorClearTimer` is cleared before re-arming.
- **WS payload/shape validation** — `maxPayload: 1MB` plus an `isClientMessage()` type guard with a
  100k text cap.
- **Path traversal on `loadSession`** — requested paths are confined to the session directory.
- **Unvalidated env ints** — `parseIntEnv` with finite fallbacks.
- **Client `JSON.parse` guard** — `try/catch` added.

## 2026-06-18 findings and resolution

### Resolved / mitigated

- **M1 — Monkey-patching `AssistantMessage.prototype.render` is fragile**
  - Resolution: `@mariozechner/pi-*` UI/runtime dependencies are pinned to the audited `0.66.1`
    package versions in `package.json`/`package-lock.json`, and `client/main.ts` now carries an
    explicit comment that the copied renderer must be re-audited before bumping `pi-web-ui`.
  - Remaining note: this is still a local override because `pi-web-ui` 0.66.1 exposes no trailing
    assistant-message metadata slot/hook. If upstream adds one, replace the override with that hook.

- **M2 — Reconnect/resume spins up a throwaway session every connect**
  - Resolution: the client includes the stored session path in the WebSocket upgrade query, and the
    server opens that session before sending `ready`/`stateSync`. The client no longer issues an
    immediate `loadSession` or redundant `getState` round-trip on `ready`.
  - Safety: the server validates the resume path with the same session-directory confinement used by
    `loadSession`; invalid or missing resume paths fall back to a fresh lazy session.
  - Upstream behavior confirmed: `SessionManager.create` is lazy about file writes until an assistant
    message exists, but avoiding the throwaway session still removes wasted state and sidebar churn.

- **L1 — `serializeMessages` rescans the full branch on every event**
  - Resolution: assistant completion timestamps are cached per `AgentSession` and reused while the
    session leaf id and message count are unchanged. This keeps the correctness of deriving end times
    from the persisted branch without rebuilding the map for repeated state syncs on unchanged state.

- **L2 — Token in query string is log-exposed**
  - Resolution: `README.md` now explicitly documents that `?token=` can appear in browser/proxy logs
    and is readable by page JavaScript, so opt-in token auth should be used only in the trusted local
    evaluation posture.

- **L3 — Unused imports**
  - Resolution: removed unused `History` and `X` lucide imports from `client/main.ts`.

## Retained low-priority notes (reasonable as-is)

- `safeSerializeEvent()` still defensively `JSON.stringify`/`JSON.parse`s agent events before the
  outer `send` serializes them again. Retained because upstream notes mention circular event objects;
  optimizing needs a careful event-shape audit.
- `prompt` remains intentionally fire-and-forget while `steer`/`followUp` are awaited — prompts stream
  asynchronously while later actions report immediate command errors.
- Static HTML is still publicly fetchable; the RCE path (`/api/ws`) is origin-checked and token-gated.
