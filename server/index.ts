import express from "express";
import { createServer } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import type {
  ClientMessage,
  ServerMessage,
  ModelInfo,
  SerializedAgentState,
  SessionListItem,
} from "../shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001");
const HOST = process.env.HOST || "127.0.0.1";
const LITELLM_URL = process.env.LITELLM_URL || "http://192.168.50.240:4000";
let litellmKey = process.env.LITELLM_KEY || "";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/ws" });

// Serve static client files in production
const clientDist = path.resolve(__dirname, "../dist");
app.use(express.static(clientDist));
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(clientDist, "client", "index.html"));
});

const HOME_DIR = os.homedir();
const AGENT_SETTINGS_PATH = path.join(HOME_DIR, ".pi", "agent", "settings.json");

let session: AgentSession;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let sessionUnsubscribe: (() => void) | undefined;
const clients = new Set<WebSocket>();

function modelToInfo(model: Model<Api>): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
  };
}

function buildModelLookupCandidates(provider: string, modelId: string): Array<{ provider: string; modelId: string }> {
  const normalizedProvider = provider.trim();
  const normalizedModelId = modelId.trim();
  const candidates: Array<{ provider: string; modelId: string }> = [];
  const seen = new Set<string>();

  const add = (candidateProvider: string, candidateModelId: string) => {
    const p = candidateProvider.trim();
    const id = candidateModelId.trim();
    if (!p || !id) return;
    const key = `${p}/${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ provider: p, modelId: id });
  };

  // Exact pair from client message first.
  add(normalizedProvider, normalizedModelId);

  // Handle merged identifiers like provider=ollama/local and modelId=Qwen...
  if (normalizedProvider.startsWith("ollama/")) {
    const providerSuffix = normalizedProvider.slice("ollama/".length);
    add("ollama", `${providerSuffix}/${normalizedModelId}`);
  }

  // Handle modelId values like ollama/local/Qwen...
  if (normalizedModelId.startsWith("ollama/")) {
    add("ollama", normalizedModelId.slice("ollama/".length));
  }

  // Best-effort fallback for Ollama if client sent bare model name.
  if (normalizedProvider === "ollama" && !normalizedModelId.includes("/")) {
    add("ollama", `local/${normalizedModelId}`);
  }

  return candidates;
}

function serializeState(): SerializedAgentState {
  const state = session.agent.state;
  return {
    messages: state.messages,
    model: state.model ? modelToInfo(state.model) : undefined,
    thinkingLevel: session.thinkingLevel,
    systemPrompt: state.systemPrompt,
    isStreaming: state.isStreaming,
    streamingMessage: state.streamingMessage,
    errorMessage: state.errorMessage,
    tools: session.getActiveToolNames(),
    sessionId: session.sessionId,
    sessionName: session.sessionName,
  };
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function fetchLiteLLMModels(): Promise<ModelInfo[]> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (litellmKey) {
      headers["Authorization"] = `Bearer ${litellmKey}`;
    }
    const res = await fetch(`${LITELLM_URL}/v1/models`, { headers });
    if (!res.ok) {
      console.error(`LiteLLM /v1/models returned ${res.status}`);
      return [];
    }
    const json = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
    return (json.data || []).map((m) => ({
      provider: "ollama",
      id: m.id.trim(),
      name: m.id.trim(),
    }));
  } catch (err) {
    console.error("Failed to fetch LiteLLM models:", err);
    return [];
  }
}

async function getRegistryModels(): Promise<ModelInfo[]> {
  const available = await modelRegistry.getAvailable();
  const configured = available.filter((m) => modelRegistry.hasConfiguredAuth(m));
  const source = configured.length > 0 ? configured : available;
  return source.map(modelToInfo);
}

async function getModels(): Promise<ModelInfo[]> {
  const litellmModels = await fetchLiteLLMModels();
  const registryModels = await getRegistryModels();

  // Merge: registry models first, then any LiteLLM models not already in registry
  const seen = new Set(registryModels.map((m) => `${m.provider}/${m.id}`));
  const merged = [...registryModels];
  for (const m of litellmModels) {
    const key = `${m.provider}/${m.id}`;
    if (!seen.has(key)) {
      merged.push(m);
      seen.add(key);
    }
  }
  return merged;
}

function findModel(provider: string, modelId: string): Model<Api> | undefined {
  return modelRegistry.find(provider, modelId);
}

function getModelFromReference(reference: string | undefined): Model<Api> | undefined {
  const trimmed = reference?.trim();
  if (!trimmed) return undefined;

  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;

  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  const model = modelRegistry.find(provider, modelId);
  return model && modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

function readAgentSettings(): any {
  try {
    return JSON.parse(fs.readFileSync(AGENT_SETTINGS_PATH, "utf8"));
  } catch (err) {
    console.warn(`Could not read Pi settings from ${AGENT_SETTINGS_PATH}:`, err);
    return {};
  }
}

async function resolveInitialWebUiModel(): Promise<Model<Api> | undefined> {
  const settings = readAgentSettings();

  // Explicit web UI override, useful for local evaluation without changing Pi's global default.
  const explicit = getModelFromReference(process.env.PI_WEBUI_MODEL || process.env.PI_MODEL);
  if (explicit) return explicit;

  const defaultProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
  const defaultModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
  if (defaultProvider && defaultModel) {
    const configuredDefault = modelRegistry.find(defaultProvider, defaultModel);
    if (configuredDefault && modelRegistry.hasConfiguredAuth(configuredDefault)) {
      return configuredDefault;
    }
    console.warn(`Configured Pi default model is not available in this SDK: ${defaultProvider}/${defaultModel}`);
  }

  // The interactive local Pi agent also scopes/cycles models from enabledModels; use the first
  // configured entry there before falling back to provider defaults like Anthropic Opus.
  if (Array.isArray(settings.enabledModels)) {
    for (const reference of settings.enabledModels) {
      if (typeof reference !== "string") continue;
      const model = getModelFromReference(reference);
      if (model) return model;
    }
  }

  const available = await modelRegistry.getAvailable();
  return available.find((m) => m.provider === "local" && modelRegistry.hasConfiguredAuth(m))
    || available.find((m) => m.provider !== "anthropic" && modelRegistry.hasConfiguredAuth(m))
    || available.find((m) => modelRegistry.hasConfiguredAuth(m));
}

async function createWebUiSession(sessionManager: SessionManager) {
  const initialModel = await resolveInitialWebUiModel();
  return createAgentSession({
    cwd: HOME_DIR,
    authStorage,
    modelRegistry,
    sessionManager,
    model: initialModel,
  });
}

function safeSerializeEvent(event: AgentSessionEvent): any {
  try {
    const json = JSON.stringify(event);
    return JSON.parse(json);
  } catch {
    // If circular refs or non-serializable data, return a simplified version
    return { type: (event as any).type, _serialized: false };
  }
}

function setupSessionEvents() {
  if (sessionUnsubscribe) sessionUnsubscribe();

  sessionUnsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const safeEvent = safeSerializeEvent(event);
    broadcast({ type: "agentEvent", event: safeEvent });

    if (
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "message_end" ||
      event.type === "turn_end"
    ) {
      broadcast({ type: "stateSync", state: serializeState() });
    }
  });
}

async function handleClientMessage(ws: WebSocket, msg: ClientMessage) {
  try {
    switch (msg.type) {
      case "prompt": {
        session.prompt(msg.text).catch((err: any) => {
          console.error("Prompt error:", err);
          broadcast({ type: "error", message: err.message || String(err) });
        });
        break;
      }
      case "steer": {
        await session.steer(msg.text);
        break;
      }
      case "followUp": {
        await session.followUp(msg.text);
        break;
      }
      case "abort": {
        await session.abort();
        broadcast({ type: "stateSync", state: serializeState() });
        break;
      }
      case "getModels": {
        const models = await getModels();
        const current = session.model ? modelToInfo(session.model) : undefined;
        send(ws, {
          type: "models",
          models,
          current,
          thinkingLevel: session.thinkingLevel,
        });
        break;
      }
      case "setModel": {
        let model: Model<Api> | undefined;
        for (const candidate of buildModelLookupCandidates(msg.provider, msg.modelId)) {
          model = findModel(candidate.provider, candidate.modelId);
          if (model) break;
        }

        if (!model) {
          send(ws, { type: "error", message: `Model not found: ${msg.provider}/${msg.modelId}` });
          return;
        }
        await session.setModel(model);
        broadcast({
          type: "modelChanged",
          model: modelToInfo(model),
          thinkingLevel: session.thinkingLevel,
        });
        break;
      }
      case "setThinkingLevel": {
        session.setThinkingLevel(msg.level as any);
        const currentModel = session.model ? modelToInfo(session.model) : { provider: "", id: "", name: "" };
        broadcast({
          type: "modelChanged",
          model: currentModel,
          thinkingLevel: session.thinkingLevel,
        });
        break;
      }
      case "getState": {
        send(ws, { type: "stateSync", state: serializeState() });
        break;
      }
      case "newSession": {
        if (session.isStreaming) {
          await session.abort();
        }
        if (sessionUnsubscribe) sessionUnsubscribe();

        const { session: newSession } = await createWebUiSession(SessionManager.create(HOME_DIR));
        session = newSession;
        setupSessionEvents();
        broadcast({ type: "sessionChanged", sessionId: session.sessionId });
        broadcast({ type: "stateSync", state: serializeState() });
        console.log(`New session created: ${session.sessionId}`);
        break;
      }
      case "getSessions": {
        const sessionInfos = await SessionManager.list(HOME_DIR);
        const items: SessionListItem[] = sessionInfos
          .sort((a, b) => b.modified.getTime() - a.modified.getTime())
          .map((s) => ({
            id: s.id,
            path: s.path,
            name: s.name,
            cwd: s.cwd,
            created: s.created.toISOString(),
            modified: s.modified.toISOString(),
            messageCount: s.messageCount,
            firstMessage: s.firstMessage,
          }));
        send(ws, { type: "sessions", sessions: items, currentSessionId: session.sessionId });
        break;
      }
      case "loadSession": {
        if (session.isStreaming) {
          await session.abort();
        }
        if (sessionUnsubscribe) sessionUnsubscribe();

        const loadedManager = SessionManager.open(msg.sessionPath, undefined, HOME_DIR);
        const { session: loadedSession } = await createWebUiSession(loadedManager);
        session = loadedSession;
        setupSessionEvents();
        broadcast({ type: "sessionChanged", sessionId: session.sessionId });
        broadcast({ type: "stateSync", state: serializeState() });
        console.log(`Loaded session: ${session.sessionId}`);
        break;
      }
    }
  } catch (err: any) {
    console.error(`Error handling ${msg.type}:`, err);
    send(ws, { type: "error", message: err.message || String(err) });
  }
}

async function main() {
  console.log("Initializing Pi agent session...");

  authStorage = AuthStorage.create();
  modelRegistry = ModelRegistry.create(authStorage);

  if (!litellmKey) {
    const key = await modelRegistry.getApiKeyForProvider("ollama");
    if (key) litellmKey = key;
  }

  const { session: agentSession, modelFallbackMessage } = await createWebUiSession(SessionManager.create(HOME_DIR));

  session = agentSession;

  if (modelFallbackMessage) {
    console.log("Model fallback:", modelFallbackMessage);
  }

  console.log(`Model: ${session.model?.provider}/${session.model?.id}`);
  console.log(`Thinking: ${session.thinkingLevel}`);
  console.log(`Tools: ${session.getActiveToolNames().join(", ")}`);

  setupSessionEvents();

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`Client connected (${clients.size} total)`);

    send(ws, { type: "ready" });
    send(ws, { type: "stateSync", state: serializeState() });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        handleClientMessage(ws, msg);
      } catch (err) {
        console.error("Invalid message:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`Client disconnected (${clients.size} total)`);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Pi WebUI server listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
