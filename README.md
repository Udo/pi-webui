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

- **Server** (`server/index.ts`): Runs one Pi SDK `AgentSession` per WebSocket client with full system access. Loads auth and model config from `~/.pi/agent` through `ModelRuntime`. Streams each client's agent events only to that client. Model discovery can use LiteLLM.
- **Client** (`client/main.ts`): Lit-based UI using `@earendil-works/pi-web-ui` components (`MessageList`, `MessageEditor`, `StreamingMessageContainer`). Communicates only through WebSocket.
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
| `PI_WEBUI_TOKEN` | *(unset)* | **Required by default** shared secret for `/api/ws` and the skills editor API. If set, open `/?token=<token>` once on first load; the client stores it in `localStorage` and removes the query parameter from the URL. |
| `PI_WEBUI_ALLOW_ANONYMOUS` | `false` | Local development escape hatch only: tokenless mode requires this flag and a loopback `HOST`. Non-loopback/public binding always requires `PI_WEBUI_TOKEN`. |
| `PI_WEBUI_ALLOWED_ORIGINS` | same host as request | Additional comma-separated WebSocket `Origin` allowlist values. |
| `PI_WEBUI_TITLE` | `Pi Web UI` | Browser title and visible application name. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent config directory for auth, models, settings, sessions, and shared skills. |
| `PI_WEBUI_SKILL_MAX_FILES` | `220` | Max SKILL parse candidates per skill directory scan. |
| `PI_WEBUI_SKILL_PARSE_BYTE_BUDGET` | `3000000` | Max total bytes read while scanning skills for a list call. |
| `PI_WEBUI_SKILL_FILE_MAX_BYTES` | `240000` | Max bytes per individual skill file. |
| `PI_WEBUI_SKILL_MAX_DEPTH` | `8` | Max recursive directory depth while scanning skill directories. |
| `PI_WEBUI_SKILL_DIRECTORY_ENTRY_LIMIT` | `1000` | Max entries inspected in any one visited skill directory. |
| `PI_WEBUI_SESSION_DIRECTORY_SCAN_LIMIT` | `800` | Max directory entries considered for a session listing scan before sorting and pagination. |
| `PI_WEBUI_SESSION_MAX_FILES` | `240` | Max session files parsed per listing request. |
| `PI_WEBUI_SESSION_PARSE_BYTE_BUDGET` | `6000000` | Max total bytes read for session list parsing per request. |
| `PI_WEBUI_SESSION_FILE_MAX_BYTES` | `220000` | Max leading bytes read from each session for bounded listing/search; large sessions remain listable but searches do not inspect content beyond this prefix. |
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
- Per-browser-client session isolation with persistence and history
- Session search, rename, deletion, stable session links, and paged loading
- Model switching with scoped/default models first and an optional full model list
- Optional scoped-only model selection and alias-only model labels
- Configurable thinking level with saved session settings restored on resume
- Startup resource summary for the model, session, tools, and advertised skills
- Activity and compaction status during long turns
- Prompt history through the Up and Down keys
- Structured tool-result summaries and paged conversation loading
- Built-in skills manager at `/skills` for private and shared skills
- Responsive session sidebar and mobile top-bar controls
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
