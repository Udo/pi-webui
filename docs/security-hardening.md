# pi-webui Security Hardening Notes

## Scope

This document summarizes hardening changes applied in `server/index.ts` and `client/main.ts` for safer markdown rendering, stronger session security defaults, and bounded parsing of untrusted local files.

## Implemented protections

### 1) Markdown link allowlist in assistant output

- Added `shared/markdown-security.ts` with:
  - `ALLOWED_MARKDOWN_LINK_SCHEMES` (explicit allowlist)
  - `sanitizeMarkdownLinks()` used by assistant message rendering in `client/main.ts`
- Allowed URL schemes are currently:
  - `http`, `https`, `mailto`, `tel`
  - Relative links (`./`, `../`, `/`) and fragment links (`#`) are preserved.
- Unsafe inline destinations are rewritten before rendering, and a global `markdown-block` post-render patch removes unsafe `href`/`src` attributes from reference links, autolinks, thinking blocks, and artifact previews as a sink-level defense.

### 2) Security response headers

`server/index.ts` now applies middleware and websocket headers for:

- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security`

This applies to HTTP responses and websocket handshake responses.

### 3) Token policy

- Anonymous tokenless mode is no longer implicit.
- Server startup requires `PI_WEBUI_TOKEN` for every non-loopback binding.
- Tokenless local development requires both `PI_WEBUI_ALLOW_ANONYMOUS=true` and loopback `HOST` (`127.0.0.1`, `::1`, or `localhost`).
- `PI_WEBUI_TOKEN` is still not accepted from query parameters.
- WebSocket auth accepts:
  - `Sec-WebSocket-Protocol` (`pi-webui-token.<base64url-token>`)
  - `x-pi-webui-token` / `Authorization: Bearer ...`
- REST auth accepts:
  - `x-pi-webui-token` / `Authorization: Bearer ...`
- Query token support was removed from server-side token parsing while client bootstrap remains via `/?token=` -> localStorage + immediate URL cleanup.

### 4) Bounded parsing for skills and sessions

Added budgeted parsing limits with explicit defaults:

- Skills:
  - `PI_WEBUI_SKILL_MAX_FILES`
  - `PI_WEBUI_SKILL_PARSE_BYTE_BUDGET`
  - `PI_WEBUI_SKILL_FILE_MAX_BYTES`
  - `PI_WEBUI_SKILL_MAX_DEPTH`
  - `PI_WEBUI_SKILL_DIRECTORY_ENTRY_LIMIT`
- Sessions:
  - `PI_WEBUI_SESSION_DIRECTORY_SCAN_LIMIT`
  - `PI_WEBUI_SESSION_MAX_FILES`
  - `PI_WEBUI_SESSION_PARSE_BYTE_BUDGET`
  - `PI_WEBUI_SESSION_FILE_MAX_BYTES`

Both listing flows stop parsing new files when request limits are reached and logically set `hasMore` where relevant. Session parsing reads only a bounded prefix from large files, so large sessions remain visible while deep full-text matches beyond the prefix are intentionally unavailable.

## Remaining risks

1. CSP is intentionally compatible with current app assumptions and still allows inline styles (`style-src 'unsafe-inline'`) because markdown + KaTeX rendering relies on inline style attributes.
2. Bounded session full-text search inspects only each file prefix; operators can raise limits deliberately when deeper historical search is required.
3. Very large skill/session trees may hide older results after configured file/count budgets are reached.
