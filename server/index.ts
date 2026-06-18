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
const LITELLM_URL = process.env.LITELLM_URL || "";
const LITELLM_TIMEOUT_MS = parseInt(process.env.LITELLM_TIMEOUT_MS || "1500");
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
const SESSION_LIST_LIMIT = parseInt(process.env.SESSION_LIST_LIMIT || "50");
const SESSION_LIST_CACHE_MS = parseInt(process.env.SESSION_LIST_CACHE_MS || "10000");

let session: AgentSession;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let sessionUnsubscribe: (() => void) | undefined;
const clients = new Set<WebSocket>();
const syntheticModels = new Map<string, Model<Api>>();
let sessionListCache: { expires: number; items: SessionListItem[] } | undefined;

function modelToInfo(model: Model<Api>, scoped = false): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    scoped,
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

function serializeState(overrides: Partial<Pick<SerializedAgentState, "isStreaming">> & { streamingMessage?: any } = {}): SerializedAgentState {
  const state = session.agent.state;
  const hasStreamingMessageOverride = Object.prototype.hasOwnProperty.call(overrides, "streamingMessage");
  return {
    messages: state.messages,
    model: state.model ? modelToInfo(state.model) : undefined,
    thinkingLevel: session.thinkingLevel,
    systemPrompt: state.systemPrompt,
    isStreaming: overrides.isStreaming ?? state.isStreaming,
    streamingMessage: hasStreamingMessageOverride ? overrides.streamingMessage : state.streamingMessage,
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

function getSessionDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(HOME_DIR, ".pi", "agent", "sessions", safePath);
}

function extractTextContent(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

function sessionItemFromContent(filePath: string, content: string, mtime: Date): SessionListItem | undefined {
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return undefined;

  const entries: any[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore malformed/incomplete append lines.
    }
  }

  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") return undefined;

  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;
  let modifiedTime = new Date(header.timestamp).getTime();

  for (const entry of entries) {
    if (typeof entry.timestamp === "string") {
      const t = new Date(entry.timestamp).getTime();
      if (!Number.isNaN(t)) modifiedTime = Math.max(modifiedTime || 0, t);
    }
    if (entry.type === "session_info") {
      name = entry.name?.trim() || undefined;
    }
    if (entry.type !== "message") continue;
    messageCount++;
    if (firstMessage || entry.message?.role !== "user") continue;
    firstMessage = extractTextContent(entry.message);
  }

  const created = new Date(header.timestamp);
  const modified = modifiedTime ? new Date(modifiedTime) : mtime;
  return {
    id: header.id,
    path: filePath,
    name,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    created: created.toISOString(),
    modified: modified.toISOString(),
    messageCount,
    firstMessage: firstMessage || "(no messages)",
  };
}

async function listRecentSessions(): Promise<SessionListItem[]> {
  const now = Date.now();
  if (sessionListCache && sessionListCache.expires > now) {
    return sessionListCache.items;
  }

  const dir = getSessionDir(HOME_DIR);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      const stats = await fs.promises.stat(filePath).catch(() => undefined);
      return stats ? { filePath, mtime: stats.mtime } : undefined;
    }));

  const newest = files
    .filter((file): file is { filePath: string; mtime: Date } => Boolean(file))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, SESSION_LIST_LIMIT);

  const items = (await Promise.all(newest.map(async ({ filePath, mtime }) => {
    const content = await fs.promises.readFile(filePath, "utf8").catch(() => "");
    return content ? sessionItemFromContent(filePath, content, mtime) : undefined;
  })))
    .filter((item): item is SessionListItem => Boolean(item))
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  sessionListCache = { expires: now + SESSION_LIST_CACHE_MS, items };
  return items;
}

function clearSessionListCache() {
  sessionListCache = undefined;
}

async function fetchLiteLLMModels(): Promise<ModelInfo[]> {
  if (!LITELLM_URL) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LITELLM_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (litellmKey) {
      headers["Authorization"] = `Bearer ${litellmKey}`;
    }
    const res = await fetch(`${LITELLM_URL}/v1/models`, { headers, signal: controller.signal });
    if (!res.ok) {
      console.error(`LiteLLM /v1/models returned ${res.status}`);
      return [];
    }
    const json = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
    return (json.data || []).map((m) => ({
      provider: "litellm",
      id: m.id.trim(),
      name: m.id.trim(),
    }));
  } catch (err) {
    console.error("Failed to fetch LiteLLM models:", err);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function parseModelReference(reference: string | undefined): { provider: string; modelId: string } | undefined {
  const trimmed = reference?.trim();
  if (!trimmed) return undefined;
  const thinkingSuffixes = [":off", ":minimal", ":low", ":medium", ":high"];
  const suffix = thinkingSuffixes.find((value) => trimmed.endsWith(value));
  const withoutThinking = suffix ? trimmed.slice(0, -suffix.length) : trimmed;
  const slash = withoutThinking.indexOf("/");
  if (slash <= 0 || slash === withoutThinking.length - 1) return undefined;
  return {
    provider: withoutThinking.slice(0, slash),
    modelId: withoutThinking.slice(slash + 1),
  };
}

function buildSyntheticModel(provider: string, modelId: string): Model<Api> | undefined {
  const key = modelKey(provider, modelId);
  const existing = syntheticModels.get(key);
  if (existing) return existing;

  const providerModels = modelRegistry.getAll().filter((m) => m.provider === provider);
  const base = providerModels.find((m) => modelRegistry.hasConfiguredAuth(m)) || providerModels[0];
  if (!base) return undefined;

  const model: Model<Api> = {
    ...base,
    id: modelId,
    name: modelId,
  };
  syntheticModels.set(key, model);
  return model;
}

function findConfiguredOrSyntheticModel(provider: string, modelId: string): Model<Api> | undefined {
  const model = modelRegistry.find(provider, modelId) || syntheticModels.get(modelKey(provider, modelId));
  if (model && modelRegistry.hasConfiguredAuth(model)) return model;
  const synthetic = buildSyntheticModel(provider, modelId);
  return synthetic && modelRegistry.hasConfiguredAuth(synthetic) ? synthetic : undefined;
}

function addModelInfo(merged: ModelInfo[], seen: Set<string>, model: Model<Api>, scoped = false) {
  const key = modelKey(model.provider, model.id);
  if (seen.has(key)) {
    if (scoped) {
      const existing = merged.find((m) => modelKey(m.provider, m.id) === key);
      if (existing) existing.scoped = true;
    }
    return;
  }
  seen.add(key);
  merged.push(modelToInfo(model, scoped));
}

async function getRegistryModels(): Promise<ModelInfo[]> {
  const settings = readAgentSettings();
  const available = await modelRegistry.getAvailable();
  const configured = available.filter((m) => modelRegistry.hasConfiguredAuth(m));
  const source = configured.length > 0 ? configured : available;
  const merged: ModelInfo[] = [];
  const seen = new Set<string>();

  const scopedReferences = [
    process.env.PI_WEBUI_MODEL,
    process.env.PI_MODEL,
    settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined,
    ...(Array.isArray(settings.enabledModels) ? settings.enabledModels : []),
  ];

  for (const reference of scopedReferences) {
    if (typeof reference !== "string") continue;
    const parsed = parseModelReference(reference);
    if (!parsed) continue;
    const model = findConfiguredOrSyntheticModel(parsed.provider, parsed.modelId);
    if (model) addModelInfo(merged, seen, model, true);
  }

  for (const model of source) {
    addModelInfo(merged, seen, model);
  }

  return merged;
}

async function getModels(): Promise<ModelInfo[]> {
  const registryModels = await getRegistryModels();
  const litellmModels = await fetchLiteLLMModels();

  const seen = new Set(registryModels.map((m) => modelKey(m.provider, m.id)));
  const merged = [...registryModels];
  for (const m of litellmModels) {
    const key = modelKey(m.provider, m.id);
    if (!seen.has(key)) {
      merged.push(m);
      seen.add(key);
    }
  }
  return merged;
}

function findModel(provider: string, modelId: string): Model<Api> | undefined {
  return findConfiguredOrSyntheticModel(provider, modelId);
}

function getModelFromReference(reference: string | undefined): Model<Api> | undefined {
  const parsed = parseModelReference(reference);
  return parsed ? findConfiguredOrSyntheticModel(parsed.provider, parsed.modelId) : undefined;
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
    const configuredDefault = findConfiguredOrSyntheticModel(defaultProvider, defaultModel);
    if (configuredDefault) {
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

    if (event.type === "message_end" || event.type === "turn_end") {
      clearSessionListCache();
    }

    if (
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "message_end" ||
      event.type === "turn_end"
    ) {
      const state = event.type === "agent_end"
        ? serializeState({ isStreaming: false, streamingMessage: null })
        : serializeState();
      broadcast({ type: "stateSync", state });
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
        clearSessionListCache();
        setupSessionEvents();
        broadcast({ type: "sessionChanged", sessionId: session.sessionId });
        broadcast({ type: "stateSync", state: serializeState() });
        console.log(`New session created: ${session.sessionId}`);
        break;
      }
      case "getSessions": {
        const items = await listRecentSessions();
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
        clearSessionListCache();
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
