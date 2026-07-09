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
| `PI_WEBUI_TOKEN` | *(unset)* | Optional shared secret for `/api/ws` and the skills editor API. If set, open `/?token=<token>` once; the client stores it in local storage for reconnects, removes `token` from the visible URL, and sends later WebSocket/authenticated API requests without keeping the token in the visible URL. Query-string tokens may still appear in browser/proxy logs for the initial page load and are readable by page JavaScript before removal, so use only on trusted local networks. If unset, WebSocket access relies on Origin checks and local/trusted hosting. |
| `PI_WEBUI_ALLOWED_ORIGINS` | same host as request | Optional comma-separated extra WebSocket `Origin` allowlist. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent config directory for auth, models, settings, sessions, and shared skills. |
| `PI_WEBUI_USER_SKILLS_DIR` | `~/.pi/skills` | Private skills edited from `/skills`. With the default working directory this is loaded by Pi as a project-local skills directory. |
| `PI_WEBUI_SHARED_SKILLS_DIR` | `$PI_CODING_AGENT_DIR/skills` | Shared read-only skills listed in `/skills` and available to all agents using this agent dir. |
| `PI_WEBUI_RESTRICT_MODELS_TO_SCOPED` | *(unset)* | If true/yes/on/1, only models from `PI_WEBUI_MODEL`, `PI_MODEL`, `settings.defaultProvider/defaultModel`, or `settings.enabledModels` are listed/selectable. |
| `PI_WEBUI_FORCE_MODEL_ALIAS_LABELS` | *(unset)* | If true/yes/on/1, show configured model aliases (`name`) instead of raw provider/model ids in the UI and response metadata. |
| `SESSION_LIST_LIMIT` | `30` | Default sessions fetched per sidebar page. |
| `SESSION_LIST_MAX_LIMIT` | `100` | Maximum sessions accepted per sidebar page request. |
| `MESSAGE_PAGE_LIMIT` | `60` | Default newest messages sent for an opened conversation. |
| `MESSAGE_PAGE_MAX_LIMIT` | `200` | Maximum messages accepted per conversation page request. |
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


## Features

- Full Pi agent with system access (bash, read, edit, write, extensions)
- Per-browser-client session isolation with persistence and history — create new sessions, rename sessions, search conversations, and browse/resume previous sessions with paged loading
- Model switching with scoped/default models first and an optional full model list (Pi model registry plus optional LiteLLM)
- Optional scoped-only model selection and alias-only model labels
- Configurable thinking level (off, minimal, low, medium, high), with saved session model/thinking restored on resume
- Streaming responses with tool execution display and paged conversation loading for long histories
- Built-in skills manager at `/skills` for creating/editing private skills under `~/.pi/skills` and viewing shared read-only skills from `$PI_CODING_AGENT_DIR/skills`; private skills with the same name take precedence
- Collapsible session sidebar (inline on desktop, overlay on mobile) plus a mobile top-bar controls menu
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
