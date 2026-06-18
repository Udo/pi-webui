# Pi Web UI

A full-stack web interface for the [Pi coding agent](https://github.com/badlogic/pi-mono), providing browser access to a system-level Pi agent with bash, file read/write/edit, and extension tools.

Read the writeup on Sleeping Robots: [Pi Web UI: A Browser Interface for the Pi Coding Agent](https://sleepingrobots.com/dreams/pi-web-ui/).

## Architecture

```
Browser (Lit + pi-web-ui components)
  │  WebSocket (/api/ws)
  ▼
Node.js server (Express + ws)
  │  Pi SDK (createAgentSession)
  ▼
System tools (bash, files, skills, extensions)
```

- **Server** (`server/index.ts`): Runs one Pi SDK `AgentSession` per WebSocket client with full system access. Loads auth and model config from `~/.pi/agent`. Streams each client's agent events only to that client. Model discovery comes from the Pi model registry, with optional LiteLLM augmentation.
- **Client** (`client/main.ts`): Lit-based UI using `@mariozechner/pi-web-ui` components (`MessageList`, `MessageEditor`, `StreamingMessageContainer`). Communicates exclusively via WebSocket.
- **Protocol** (`shared/protocol.ts`): Typed JSON message definitions for the WebSocket wire format.

## Setup

```bash
npm install
npm run build
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server listen port |
| `HOST` | `127.0.0.1` | Server listen address. Use `0.0.0.0` only on a trusted network and with `PI_WEBUI_TOKEN` set. |
| `PI_WEBUI_TOKEN` | *(unset)* | Optional shared secret for `/api/ws`. If set, open `/?token=<token>` once; the client stores it in local storage for reconnects. Query-string tokens can appear in browser/proxy logs and are readable by page JavaScript, so use only on trusted local networks. If unset, access relies on WebSocket Origin checks. |
| `PI_WEBUI_ALLOWED_ORIGINS` | same host as request | Optional comma-separated extra WebSocket `Origin` allowlist. |
| `SESSION_LIST_LIMIT` | `50` | Maximum recent sessions parsed for the sidebar. |
| `SESSION_LIST_CACHE_MS` | `10000` | Sessions sidebar cache TTL. |
| `LITELLM_URL` | *(empty)* | Optional LiteLLM API base URL for extra model listing. |
| `LITELLM_KEY` | *(from ~/.pi/agent)* | LiteLLM API key (auto-detected from Pi config if unset) |

### Development

```bash
npm run dev
```

Starts the server (`tsx watch`) on port 3001 and Vite dev server on port 5173 with WebSocket proxy.

### Production

```bash
npm run build
HOST=127.0.0.1 PORT=8085 PI_WEBUI_TOKEN=change-me npm start
```

Or use the systemd user service:

```bash
cp pi-webui.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-webui.service
```

## Features

- Full Pi agent with system access (bash, read, edit, write, extensions)
- Per-browser-client session isolation with persistence and history — create new sessions, browse and resume previous ones
- Model switching with scoped/default models first and an optional full model list (Pi model registry plus optional LiteLLM)
- Configurable thinking level (off, minimal, low, medium, high)
- Streaming responses with tool execution display
- Collapsible session sidebar (inline on desktop, overlay on mobile)
- Dark/light theme toggle with green accent

## Project structure

```
├── client/
│   ├── index.html        Entry point
│   ├── main.ts           Client application (state, WebSocket, rendering)
│   └── app.css           Theme overrides and sidebar styles
├── server/
│   └── index.ts          Express + WebSocket server, Pi SDK session
├── shared/
│   └── protocol.ts       WebSocket message type definitions
├── vite.config.ts        Vite config (build, dev proxy)
├── tsconfig.json         TypeScript config
└── package.json          Dependencies and scripts
```
