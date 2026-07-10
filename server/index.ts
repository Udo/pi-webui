import express from "express";
import { createHash, timingSafeEqual } from "crypto";
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
  defineTool,
  DefaultResourceLoader,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import {
  canReadFile,
  createParsingState,
  markStopped,
  parseDepthIsAllowed,
  recordRead,
  type ParsingLimits,
} from "./parsing-budget.js";
import { Type, type Model, type Api } from "@mariozechner/pi-ai";
import type {
  ClientMessage,
  ServerMessage,
  ModelInfo,
  SerializedAgentState,
  SessionListItem,
} from "../shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function parseIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function parseLimitedIntEnv(name: string, fallback: number): number {
  const value = parseIntEnv(name, fallback);
  return value > 0 ? value : fallback;
}

const PORT = parseIntEnv("PORT", 3001);
const HOST = process.env.HOST || "127.0.0.1";
const LITELLM_URL = process.env.LITELLM_URL || "";
const LITELLM_TIMEOUT_MS = parseIntEnv("LITELLM_TIMEOUT_MS", 1500);
let litellmKey = process.env.LITELLM_KEY || "";

const app = express();
const server = createServer(app);
const webUiToken = (process.env.PI_WEBUI_TOKEN || "").trim();
const allowAnonymous = ["1", "true", "yes", "on"].includes((process.env.PI_WEBUI_ALLOW_ANONYMOUS || "").trim().toLowerCase());
const anonymousLoopbackOnly = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
const allowedOrigins = new Set(
  (process.env.PI_WEBUI_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const SECURITY_HEADERS = {
  csp: "default-src 'self'; base-uri 'self'; form-action 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none';",
  hsts: "max-age=31536000; includeSubDomains; preload",
  referrerPolicy: "strict-origin-when-cross-origin",
  frameOptions: "DENY",
  contentTypeOptions: "nosniff",
};

const SKILL_PARSE_LIMITS: ParsingLimits = {
  maxFiles: parseLimitedIntEnv("PI_WEBUI_SKILL_MAX_FILES", 220),
  maxBytesTotal: parseLimitedIntEnv("PI_WEBUI_SKILL_PARSE_BYTE_BUDGET", 3_000_000),
  maxBytesPerFile: parseLimitedIntEnv("PI_WEBUI_SKILL_FILE_MAX_BYTES", 240_000),
};
const SKILL_MAX_DEPTH = parseLimitedIntEnv("PI_WEBUI_SKILL_MAX_DEPTH", 8);
const SKILL_DIRECTORY_ENTRY_LIMIT = parseLimitedIntEnv("PI_WEBUI_SKILL_DIRECTORY_ENTRY_LIMIT", 1000);

const SESSION_PARSE_LIMITS: ParsingLimits = {
  maxFiles: parseLimitedIntEnv("PI_WEBUI_SESSION_MAX_FILES", 240),
  maxBytesTotal: parseLimitedIntEnv("PI_WEBUI_SESSION_PARSE_BYTE_BUDGET", 6_000_000),
  maxBytesPerFile: parseLimitedIntEnv("PI_WEBUI_SESSION_FILE_MAX_BYTES", 220_000),
};
const SESSION_DIRECTORY_SCAN_LIMIT = parseLimitedIntEnv("PI_WEBUI_SESSION_DIRECTORY_SCAN_LIMIT", 800);

function isAllowedWsOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return Boolean(hostHeader) && url.host === hostHeader;
  } catch {
    return false;
  }
}

function isValidToken(candidate: string | undefined): boolean {
  if (!webUiToken && !allowAnonymous) return false;
  if (!webUiToken) return true;
  if (!candidate) return false;
  const expected = Buffer.from(webUiToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenFromRequestHeader(req: express.Request): string | undefined {
  const header = req.header("x-pi-webui-token") || req.header("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return header.trim();
}

function tokenFromWebSocketHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
  const header = headers["x-pi-webui-token"] || headers["X-PI-WEBUI-TOKEN"];
  if (!header) return undefined;
  if (Array.isArray(header)) return header[0]?.trim();
  const value = typeof header === "string" ? header.trim() : "";
  if (value.toLowerCase().startsWith("bearer ")) return value.slice(7).trim();
  return value;
}

function tokenFromWebSocketProtocol(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return undefined;
  for (const item of raw.split(",")) {
    const protocol = item.trim();
    if (!protocol.startsWith("pi-webui-token.")) continue;
    const encoded = protocol.slice("pi-webui-token.".length);
    if (!encoded) continue;
    try {
      return Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const wss = new WebSocketServer({
  server,
  path: "/api/ws",
  maxPayload: 1024 * 1024,
  verifyClient: (info, done) => {
    const originOk = isAllowedWsOrigin(info.origin, info.req.headers.host);
    const protocolToken = tokenFromWebSocketProtocol(info.req.headers["sec-websocket-protocol"]);
    const headerToken = tokenFromWebSocketHeaders(info.req.headers as Record<string, string | string[] | undefined>);
    const tokenOk = isValidToken(protocolToken || headerToken);
    done(originOk && tokenOk, originOk ? 401 : 403, originOk ? "Unauthorized" : "Forbidden");
  },
});

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", SECURITY_HEADERS.csp);
  res.setHeader("X-Content-Type-Options", SECURITY_HEADERS.contentTypeOptions);
  res.setHeader("Referrer-Policy", SECURITY_HEADERS.referrerPolicy);
  res.setHeader("X-Frame-Options", SECURITY_HEADERS.frameOptions);
  res.setHeader("Strict-Transport-Security", SECURITY_HEADERS.hsts);
  next();
});
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.json({ limit: "256kb" }));

wss.on("headers", (headers) => {
  headers.push(`Content-Security-Policy: ${SECURITY_HEADERS.csp}`);
  headers.push(`X-Content-Type-Options: ${SECURITY_HEADERS.contentTypeOptions}`);
  headers.push(`Referrer-Policy: ${SECURITY_HEADERS.referrerPolicy}`);
  headers.push(`X-Frame-Options: ${SECURITY_HEADERS.frameOptions}`);
  headers.push(`Strict-Transport-Security: ${SECURITY_HEADERS.hsts}`);
});

const HOME_DIR = os.homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME_DIR, ".pi", "agent");
const AGENT_SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const USER_SKILLS_DIR = process.env.PI_WEBUI_USER_SKILLS_DIR || path.join(HOME_DIR, ".pi", "skills");
const SHARED_SKILLS_DIR = process.env.PI_WEBUI_SHARED_SKILLS_DIR || path.join(AGENT_DIR, "skills");
const SESSION_LIST_LIMIT = parseIntEnv("SESSION_LIST_LIMIT", 30);
const SESSION_LIST_MAX_LIMIT = parseIntEnv("SESSION_LIST_MAX_LIMIT", 100);
const MESSAGE_PAGE_LIMIT = parseIntEnv("MESSAGE_PAGE_LIMIT", 60);
const MESSAGE_PAGE_MAX_LIMIT = parseIntEnv("MESSAGE_PAGE_MAX_LIMIT", 200);
const SESSION_LIST_CACHE_MS = parseIntEnv("SESSION_LIST_CACHE_MS", 10000);

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
type ChoiceRequest = {
  id: string;
  prompt: string;
  choices: Array<{ id: string; label: string; description?: string }>;
  allowMultiple: boolean;
};

type PendingChoiceRequest = ChoiceRequest & {
  resolve: (selected: string[]) => void;
  reject: (error: Error) => void;
};

type ClientRuntime = { session: AgentSession; unsubscribe?: () => void; pendingChoices?: Map<string, PendingChoiceRequest> };
const clients = new Map<WebSocket, ClientRuntime>();
const syntheticModels = new Map<string, Model<Api>>();
let modelConfigStamp = "";
let sessionListCache: { expires: number; files: { filePath: string; mtime: Date }[] } | undefined;

function boolEnv(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] || "").trim().toLowerCase());
}

function restrictModelsToScoped(): boolean {
  return boolEnv("PI_WEBUI_RESTRICT_MODELS_TO_SCOPED");
}

function forceModelAliasLabels(): boolean {
  return boolEnv("PI_WEBUI_FORCE_MODEL_ALIAS_LABELS");
}

type SkillSource = "user" | "shared";

type SkillListItem = {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  editable: boolean;
  diagnostics: string[];
};

function isValidSkillName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return false;
  for (const ch of name) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
    if (!ok) return false;
  }
  return true;
}

function normalizeSkillDescription(value: string): string {
  return value.split(" ").filter(Boolean).join(" ").replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("\t", " ").trim();
}

function parseSkillFrontmatter(content: string): { fields: Record<string, string>; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const fields: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    diagnostics.push("missing frontmatter fence");
    return { fields, diagnostics };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    diagnostics.push("missing closing frontmatter fence");
    return { fields, diagnostics };
  }
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    fields[key] = value;
  }
  if (!fields.name) diagnostics.push("missing name");
  else if (!isValidSkillName(fields.name)) diagnostics.push("invalid name: use lowercase letters, numbers, and single hyphens only");
  if (!fields.description) diagnostics.push("missing description");
  else if (fields.description.length > 1024) diagnostics.push("description exceeds 1024 characters");
  return { fields, diagnostics };
}

async function readSkillFile(filePath: string, source: SkillSource, editable: boolean, state: ReturnType<typeof createParsingState>): Promise<SkillListItem | undefined> {
  const stats = await fs.promises.stat(filePath).catch(() => undefined);
  const sizeBytes = stats?.size ?? 0;
  const decision = canReadFile(sizeBytes, SKILL_PARSE_LIMITS, state);
  if (!decision.canRead) {
    if (decision.stop) markStopped(state, decision.reason!);
    return undefined;
  }

  const content = await fs.promises.readFile(filePath, "utf8").catch(() => "");
  if (!content) return undefined;
  const { fields, diagnostics } = parseSkillFrontmatter(content);
  if (!fields.description) {
    recordRead(sizeBytes, state);
    return undefined;
  }
  const folderName = path.basename(path.dirname(filePath));
  const name = fields.name || folderName;
  const id = source === "user" && isValidSkillName(name) ? name : createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);

  recordRead(sizeBytes, state);
  return { id, name, description: fields.description || "", path: filePath, source, editable, diagnostics };
}

async function readDirectoryEntriesLimited(dir: string, maxEntries: number): Promise<fs.Dirent[]> {
  const out: fs.Dirent[] = [];
  const handle = await fs.promises.opendir(dir).catch(() => undefined);
  if (!handle) return out;
  try {
    for await (const entry of handle) {
      out.push(entry);
      if (maxEntries > 0 && out.length >= maxEntries) break;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return out;
}

async function collectSkillsFromRoot(root: string, source: SkillSource, editable: boolean): Promise<SkillListItem[]> {
  const out: SkillListItem[] = [];
  const state = createParsingState();

  const visit = async (dir: string, depth: number, allowRootFiles: boolean): Promise<void> => {
    if (state.stopReason) return;
    if (!parseDepthIsAllowed(depth, SKILL_MAX_DEPTH)) {
      return;
    }

    const entries = await readDirectoryEntriesLimited(dir, SKILL_DIRECTORY_ENTRY_LIMIT);
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const item = await readSkillFile(path.join(dir, "SKILL.md"), source, editable, state);
      if (item) out.push(item);
      return;
    }

    for (const entry of entries) {
      if (state.stopReason) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1, false);
      } else if (allowRootFiles && entry.isFile() && entry.name.endsWith(".md")) {
        const item = await readSkillFile(fullPath, source, editable, state);
        if (item) out.push(item);
      }
    }
  };

  await visit(root, 1, true);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listSkills(): Promise<SkillListItem[]> {
  const [userSkills, sharedSkills] = await Promise.all([
    collectSkillsFromRoot(USER_SKILLS_DIR, "user", true),
    collectSkillsFromRoot(SHARED_SKILLS_DIR, "shared", false),
  ]);
  const userNames = new Set(userSkills.map((skill) => skill.name));
  return [...userSkills, ...sharedSkills.filter((skill) => !userNames.has(skill.name))];
}

function userSkillPath(name: string): string | undefined {
  if (!isValidSkillName(name)) return undefined;
  const root = path.resolve(USER_SKILLS_DIR);
  const skillFile = path.resolve(root, name, "SKILL.md");
  if (!skillFile.startsWith(`${root}${path.sep}`)) return undefined;
  return skillFile;
}

async function writeSkillAtomic(skillFile: string, content: string) {
  await fs.promises.mkdir(path.dirname(skillFile), { recursive: true, mode: 0o700 });
  const tmp = `${skillFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, content, { mode: 0o600 });
  await fs.promises.rename(tmp, skillFile);
}

async function getSkillContent(source: string, id: string): Promise<{ item: SkillListItem; content: string } | undefined> {
  if (source !== "user" && source !== "shared") return undefined;
  const skills = await listSkills();
  const item = skills.find((skill) => skill.source === source && skill.id === id);
  if (!item) return undefined;

  const stat = await fs.promises.stat(item.path).catch(() => undefined);
  if (!stat || stat.size > SKILL_PARSE_LIMITS.maxBytesPerFile) return undefined;
  const content = await fs.promises.readFile(item.path, "utf8");
  return { item, content };
}

function tokenFromRequest(req: express.Request): string | undefined {
  return tokenFromRequestHeader(req);
}

function requireEditAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isValidToken(tokenFromRequest(req))) return next();
  res.status(401).json({ ok: false, error: "unauthorized" });
}

function fileStamp(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function refreshModelConfigIfChanged() {
  const nextStamp = [
    fileStamp(path.join(AGENT_DIR, "auth.json")),
    fileStamp(path.join(AGENT_DIR, "models.json")),
    fileStamp(AGENT_SETTINGS_PATH),
  ].join("|");
  if (nextStamp === modelConfigStamp) return;
  modelConfigStamp = nextStamp;
  authStorage?.reload();
  modelRegistry?.refresh();
  syntheticModels.clear();
}

function modelToInfo(model: Model<Api>, scoped = false): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    scoped,
    forceAliasLabel: forceModelAliasLabels(),
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

type MessageCompletionCache = {
  leafId: string | null;
  messageCount: number;
  completedAtByKey: Map<string, number[]>;
};

const messageCompletionCache = new WeakMap<AgentSession, MessageCompletionCache>();

function getMessageCompletionTimes(session: AgentSession): Map<string, number[]> {
  const leafId = session.sessionManager.getLeafId();
  const messageCount = session.agent.state.messages.length;
  const cached = messageCompletionCache.get(session);
  if (cached && cached.leafId === leafId && cached.messageCount === messageCount) {
    return new Map([...cached.completedAtByKey].map(([key, values]) => [key, [...values]]));
  }

  const completedAtByKey = new Map<string, number[]>();
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const timestamp = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;
    const message = entry.message as any;
    const key = `${message.role}:${message.timestamp ?? ""}`;
    const queue = completedAtByKey.get(key) || [];
    queue.push(timestamp);
    completedAtByKey.set(key, queue);
  }

  messageCompletionCache.set(session, {
    leafId,
    messageCount,
    completedAtByKey: new Map([...completedAtByKey].map(([key, values]) => [key, [...values]])),
  });
  return completedAtByKey;
}

function serializeMessages(session: AgentSession, offset = 0, limit?: number): any[] {
  const source = session.agent.state.messages;
  const messages = limit === undefined ? source.slice(offset) : source.slice(offset, offset + limit);
  const completedAtByKey = getMessageCompletionTimes(session);
  for (let i = 0; i < offset; i++) {
    const message = source[i] as any;
    if (!message) continue;
    const key = `${message.role}:${message.timestamp ?? ""}`;
    completedAtByKey.get(key)?.shift();
  }
  return messages.map((message: any) => {
    const key = `${message.role}:${message.timestamp ?? ""}`;
    const completedAt = completedAtByKey.get(key)?.shift();
    if (message.role !== "assistant" || !completedAt) return message;
    return { ...message, piWebuiCompletedAt: completedAt };
  });
}

function messagePage(session: AgentSession, offset: number, limit = MESSAGE_PAGE_LIMIT) {
  const total = session.agent.state.messages.length;
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), MESSAGE_PAGE_MAX_LIMIT);
  const safeOffset = Math.min(Math.max(0, Math.floor(offset)), total);
  return {
    messages: serializeMessages(session, safeOffset, safeLimit),
    offset: safeOffset,
    limit: safeLimit,
    total,
    hasMoreBefore: safeOffset > 0,
  };
}

function serializeState(session: AgentSession, overrides: Partial<Pick<SerializedAgentState, "isStreaming">> & { streamingMessage?: any } = {}): SerializedAgentState {
  const state = session.agent.state;
  const hasStreamingMessageOverride = Object.prototype.hasOwnProperty.call(overrides, "streamingMessage");
  const totalMessages = state.messages.length;
  const messagesOffset = Math.max(0, totalMessages - MESSAGE_PAGE_LIMIT);
  const messages = serializeMessages(session, messagesOffset, MESSAGE_PAGE_LIMIT);
  return {
    messages,
    messagesOffset,
    messagesTotal: totalMessages,
    hasMoreMessagesBefore: messagesOffset > 0,
    model: state.model ? modelToInfo(state.model) : undefined,
    thinkingLevel: session.thinkingLevel,
    systemPrompt: state.systemPrompt,
    isStreaming: overrides.isStreaming ?? state.isStreaming,
    streamingMessage: hasStreamingMessageOverride ? overrides.streamingMessage : state.streamingMessage,
    errorMessage: state.errorMessage,
    tools: session.getActiveToolNames(),
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    sessionPath: session.sessionFile,
  };
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getSessionDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(AGENT_DIR, "sessions", safePath);
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

async function sessionFiles(): Promise<{ filePath: string; mtime: Date }[]> {
  const now = Date.now();
  if (sessionListCache && sessionListCache.expires > now) return sessionListCache.files;

  const dir = getSessionDir(HOME_DIR);
  const entries = await readDirectoryEntriesLimited(dir, SESSION_DIRECTORY_SCAN_LIMIT);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    // Sort the bounded candidate set before stat calls and pagination.
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, SESSION_DIRECTORY_SCAN_LIMIT);
  const files = (await Promise.all(candidates.map(async (entry) => {
    const filePath = path.join(dir, entry.name);
    const stats = await fs.promises.stat(filePath).catch(() => undefined);
    return stats ? { filePath, mtime: stats.mtime } : undefined;
  })))
    .filter((file): file is { filePath: string; mtime: Date } => Boolean(file))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  sessionListCache = { expires: now + SESSION_LIST_CACHE_MS, files };
  return files;
}

async function readSessionHead(filePath: string, state: ReturnType<typeof createParsingState>): Promise<string | undefined> {
  if (SESSION_PARSE_LIMITS.maxFiles > 0 && state.files >= SESSION_PARSE_LIMITS.maxFiles) {
    markStopped(state, "file-count-limit");
    return undefined;
  }
  const remaining = SESSION_PARSE_LIMITS.maxBytesTotal > 0
    ? SESSION_PARSE_LIMITS.maxBytesTotal - state.bytes
    : SESSION_PARSE_LIMITS.maxBytesPerFile;
  const cap = Math.min(SESSION_PARSE_LIMITS.maxBytesPerFile, remaining);
  if (cap <= 0) {
    markStopped(state, "request-byte-limit");
    return undefined;
  }
  const handle = await fs.promises.open(filePath, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    const bytesToRead = Math.min(stats.size, cap);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    recordRead(bytesRead, state);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function listRecentSessions(options: { offset?: number; limit?: number; query?: string } = {}): Promise<{ items: SessionListItem[]; total: number; hasMore: boolean; offset: number; limit: number; query: string }> {
  const offset = Math.max(0, Math.floor(options.offset || 0));
  const limit = Math.min(Math.max(1, Math.floor(options.limit || SESSION_LIST_LIMIT)), SESSION_LIST_MAX_LIMIT);
  const query = (options.query || "").trim().toLowerCase();
  const files = await sessionFiles();
  const matched: SessionListItem[] = [];
  const state = createParsingState();
  let seenMatches = 0;
  let hasMore = false;

  for (const { filePath, mtime } of files) {
    if (state.stopReason) {
      hasMore = true;
      break;
    }

    const content = await readSessionHead(filePath, state);
    if (!content) {
      if (state.stopReason) hasMore = true;
      continue;
    }

    const item = sessionItemFromContent(filePath, content, mtime);
    if (!item) continue;

    const haystack = query ? `${item.name || ""}\n${item.firstMessage}\n${content}`.toLowerCase() : "";
    if (query && !haystack.includes(query)) continue;
    if (seenMatches++ < offset) continue;
    if (matched.length >= limit) {
      hasMore = true;
      break;
    }
    matched.push(item);
  }

  return { items: matched, total: offset + matched.length + (hasMore ? 1 : 0), hasMore, offset, limit, query: options.query || "" };
}

function clearSessionListCache() {
  sessionListCache = undefined;
}

function resolveSessionPath(candidate: string): string | undefined {
  const sessionDir = path.resolve(getSessionDir(HOME_DIR));
  const requestedPath = path.resolve(candidate);
  if (!requestedPath.startsWith(`${sessionDir}${path.sep}`)) return undefined;
  return requestedPath;
}

function sessionManagerForResumePath(candidate: string | undefined): SessionManager {
  if (!candidate) return SessionManager.create(HOME_DIR, getSessionDir(HOME_DIR));
  const requestedPath = resolveSessionPath(candidate);
  if (!requestedPath) {
    console.warn("Ignoring resume path outside configured session directory");
    return SessionManager.create(HOME_DIR, getSessionDir(HOME_DIR));
  }
  if (!fs.existsSync(requestedPath)) {
    console.warn("Ignoring missing resume session path");
    return SessionManager.create(HOME_DIR, getSessionDir(HOME_DIR));
  }
  return SessionManager.open(requestedPath, getSessionDir(HOME_DIR), HOME_DIR);
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

function scopedModelReferences(settings: any): string[] {
  return [
    process.env.PI_WEBUI_MODEL,
    process.env.PI_MODEL,
    settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined,
    ...(Array.isArray(settings.enabledModels) ? settings.enabledModels : []),
  ].filter((reference): reference is string => typeof reference === "string" && reference.trim() !== "");
}

function scopedModelKeys(settings: any): Set<string> {
  const keys = new Set<string>();
  for (const reference of scopedModelReferences(settings)) {
    const parsed = parseModelReference(reference);
    if (parsed) keys.add(modelKey(parsed.provider, parsed.modelId));
  }
  return keys;
}

async function getRegistryModels(): Promise<ModelInfo[]> {
  refreshModelConfigIfChanged();
  const settings = readAgentSettings();
  const available = await modelRegistry.getAvailable();
  const configured = available.filter((m) => modelRegistry.hasConfiguredAuth(m));
  const source = configured.length > 0 ? configured : available;
  const merged: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const reference of scopedModelReferences(settings)) {
    const parsed = parseModelReference(reference);
    if (!parsed) continue;
    const model = findConfiguredOrSyntheticModel(parsed.provider, parsed.modelId);
    if (model) addModelInfo(merged, seen, model, true);
  }

  if (restrictModelsToScoped()) return merged;

  for (const model of source) {
    addModelInfo(merged, seen, model);
  }

  return merged;
}

async function getModels(): Promise<ModelInfo[]> {
  const registryModels = await getRegistryModels();
  if (restrictModelsToScoped()) return registryModels;
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

function isModelSelectable(provider: string, modelId: string): boolean {
  if (!restrictModelsToScoped()) return true;
  return scopedModelKeys(readAgentSettings()).has(modelKey(provider, modelId));
}

function defaultThinkingLevelFromSettings(): any {
  const level = readAgentSettings().defaultThinkingLevel;
  return typeof level === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(level) ? level : "medium";
}

function applyDefaultThinkingLevel(session: AgentSession) {
  if (session.model?.reasoning === true) {
    session.setThinkingLevel(defaultThinkingLevelFromSettings());
  }
}

function restorableSessionModel(sessionManager: SessionManager): Model<Api> | undefined {
  const existingModel = sessionManager.buildSessionContext().model;
  if (!existingModel) return undefined;
  const model = findConfiguredOrSyntheticModel(existingModel.provider, existingModel.modelId);
  if (!model || !isModelSelectable(model.provider, model.id)) return undefined;
  return model;
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

  // Explicit web UI override without changing Pi's global default.
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

const requestChoiceParams = Type.Object({
  prompt: Type.String({ description: "Short question shown to the user." }),
  choices: Type.Array(Type.Object({
    id: Type.String({ description: "Stable machine-readable choice id." }),
    label: Type.String({ description: "Short button label." }),
    description: Type.Optional(Type.String({ description: "Optional one-line explanation." })),
  }), { description: "2-6 concrete choices." }),
  allowMultiple: Type.Optional(Type.Boolean({ description: "Whether the user may choose multiple options. Default false." })),
});

function createRequestChoiceTool(onChoiceRequest: (request: ChoiceRequest, signal?: AbortSignal) => Promise<string[]>) {
  return defineTool({
    name: "request-choice",
    label: "request-choice",
    description: "Ask the user to choose from concrete options when guessing would be risky.",
    promptSnippet: "request-choice: ask the user to choose one or more concrete options.",
    promptGuidelines: [
      "Use request-choice for discrete user decisions where guessing would be risky. Keep choices few and concrete.",
      "After calling request-choice, stop and wait for the user's choice response instead of continuing to guess.",
    ],
    parameters: requestChoiceParams,
    async execute(toolCallId, params, signal) {
      const choices = (params.choices || []).slice(0, 8).map((choice: any, index: number) => ({
        id: String(choice.id || `choice-${index + 1}`).trim().slice(0, 80),
        label: String(choice.label || choice.id || `Choice ${index + 1}`).trim().slice(0, 120),
        description: choice.description ? String(choice.description).trim().slice(0, 300) : undefined,
      })).filter((choice: any) => choice.id && choice.label);
      if (choices.length < 2) {
        const data = { type: "error", error: "request_choice_needs_choices", message: "request-choice requires at least two non-empty choices." };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data } as any;
      }
      const request: ChoiceRequest = {
        id: toolCallId,
        prompt: String(params.prompt || "Please choose an option.").trim().slice(0, 500),
        choices,
        allowMultiple: Boolean(params.allowMultiple),
      };
      const selected = await onChoiceRequest(request, signal);
      const data = { type: "choice_response", request, selected };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data } as any;
    },
  });
}

async function createWebUiSession(sessionManager: SessionManager, onChoiceRequest: (request: ChoiceRequest, signal?: AbortSignal) => Promise<string[]>) {
  refreshModelConfigIfChanged();
  const restoredModel = restorableSessionModel(sessionManager);
  const initialModel = restoredModel ? undefined : await resolveInitialWebUiModel();
  const initialThinkingLevel = restoredModel ? undefined : defaultThinkingLevelFromSettings();
  const customTools = [createRequestChoiceTool(onChoiceRequest)];
  const settingsManager = SettingsManager.create(HOME_DIR, AGENT_DIR);
  const resourceLoader = new DefaultResourceLoader({
    cwd: HOME_DIR,
    agentDir: AGENT_DIR,
    settingsManager,
    additionalSkillPaths: [USER_SKILLS_DIR, SHARED_SKILLS_DIR],
  });
  await resourceLoader.reload();
  const result = await createAgentSession({
    cwd: HOME_DIR,
    agentDir: AGENT_DIR,
    authStorage,
    modelRegistry,
    sessionManager,
    model: initialModel,
    thinkingLevel: initialThinkingLevel,
    customTools,
    settingsManager,
    resourceLoader,
  });
  if (!restoredModel) applyDefaultThinkingLevel(result.session);
  result.session.setActiveToolsByName([...new Set([...result.session.getActiveToolNames(), ...customTools.map((tool) => tool.name)])]);
  return result;
}

function waitForChoiceResponse(ws: WebSocket, pendingChoices: Map<string, PendingChoiceRequest>, request: ChoiceRequest, signal?: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const pending: PendingChoiceRequest = { ...request, resolve, reject };
    const abort = () => {
      pendingChoices.delete(request.id);
      send(ws, { type: "agentEvent", event: { type: "choice_resolved", requestId: request.id, selected: [] } });
      reject(new Error("Choice request was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    pending.resolve = (selected) => {
      signal?.removeEventListener("abort", abort);
      resolve(selected);
    };
    pending.reject = (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    pendingChoices.set(request.id, pending);
    send(ws, { type: "agentEvent", event: { type: "choice_request", request } });
  });
}

function clearPendingChoices(ws: WebSocket, runtime: ClientRuntime, reason: string) {
  for (const [id, pending] of runtime.pendingChoices || []) {
    pending.reject(new Error(reason));
    send(ws, { type: "agentEvent", event: { type: "choice_resolved", requestId: id, selected: [] } });
  }
  runtime.pendingChoices?.clear();
}

function safeSerializeEvent(event: AgentSessionEvent): any {
  try {
    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);
    if (parsed?.type === "agent_end" && Array.isArray(parsed.messages)) {
      return { ...parsed, messages: undefined, messagesTruncated: true };
    }
    return parsed;
  } catch {
    // If circular refs or non-serializable data, return a simplified version
    return { type: (event as any).type, _serialized: false };
  }
}

function setupSessionEvents(ws: WebSocket, runtime: ClientRuntime) {
  if (runtime.unsubscribe) runtime.unsubscribe();

  runtime.unsubscribe = runtime.session.subscribe((event: AgentSessionEvent) => {
    const safeEvent = safeSerializeEvent(event);
    send(ws, { type: "agentEvent", event: safeEvent });

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
        ? serializeState(runtime.session, { isStreaming: false, streamingMessage: null })
        : serializeState(runtime.session);
      send(ws, { type: "stateSync", state });
    }
  });
}

function isClientMessage(value: any): value is ClientMessage {
  if (!value || typeof value.type !== "string") return false;
  switch (value.type) {
    case "prompt":
    case "steer":
    case "followUp":
      return typeof value.text === "string" && value.text.length <= 100_000;
    case "setModel":
      return typeof value.provider === "string" && typeof value.modelId === "string";
    case "setThinkingLevel":
      return typeof value.level === "string";
    case "loadSession":
      return typeof value.sessionPath === "string";
    case "renameSession":
      return typeof value.sessionPath === "string" && typeof value.name === "string" && value.name.length <= 200;
    case "choiceResponse":
      return typeof value.requestId === "string" && value.requestId.length <= 200 && Array.isArray(value.selected) && value.selected.length <= 8 && value.selected.every((item: any) => typeof item === "string" && item.length <= 80);
    case "getMessages":
      return typeof value.offset === "number";
    case "abort":
    case "getModels":
    case "getState":
    case "newSession":
    case "getSessions":
      return true;
    default:
      return false;
  }
}

async function handleClientMessage(ws: WebSocket, msg: ClientMessage) {
  const runtime = clients.get(ws);
  if (!runtime) {
    send(ws, { type: "error", message: "Session is not ready yet" });
    return;
  }
  let session = runtime.session;

  try {
    switch (msg.type) {
      case "prompt": {
        session.prompt(msg.text).catch((err: any) => {
          console.error("Prompt error:", err);
          send(ws, { type: "error", message: err.message || String(err) });
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
      case "choiceResponse": {
        const request = runtime.pendingChoices?.get(msg.requestId);
        if (!request) {
          send(ws, { type: "error", message: "Choice request is no longer active" });
          break;
        }
        const allowed = new Map(request.choices.map((choice) => [choice.id, choice]));
        const selected = msg.selected.filter((id) => allowed.has(id));
        if (!request.allowMultiple && selected.length > 1) selected.splice(1);
        if (selected.length === 0) {
          send(ws, { type: "error", message: "Please choose one of the listed options" });
          break;
        }
        runtime.pendingChoices?.delete(msg.requestId);
        request.resolve(selected);
        send(ws, { type: "agentEvent", event: { type: "choice_resolved", requestId: msg.requestId, selected } });
        break;
      }
      case "abort": {
        await session.abort();
        send(ws, { type: "stateSync", state: serializeState(session) });
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
        refreshModelConfigIfChanged();
        let model: Model<Api> | undefined;
        for (const candidate of buildModelLookupCandidates(msg.provider, msg.modelId)) {
          model = findModel(candidate.provider, candidate.modelId);
          if (model) break;
        }

        if (!model) {
          send(ws, { type: "error", message: `Model not found: ${msg.provider}/${msg.modelId}` });
          return;
        }
        if (!isModelSelectable(model.provider, model.id)) {
          send(ws, { type: "error", message: `Model is not enabled for this Web UI: ${model.provider}/${model.id}` });
          return;
        }
        await session.setModel(model);
        applyDefaultThinkingLevel(session);
        send(ws, {
          type: "modelChanged",
          model: modelToInfo(model),
          thinkingLevel: session.thinkingLevel,
        });
        break;
      }
      case "setThinkingLevel": {
        session.setThinkingLevel(msg.level as any);
        const currentModel = session.model ? modelToInfo(session.model) : { provider: "", id: "", name: "" };
        send(ws, {
          type: "modelChanged",
          model: currentModel,
          thinkingLevel: session.thinkingLevel,
        });
        break;
      }
      case "getState": {
        send(ws, { type: "stateSync", state: serializeState(session) });
        break;
      }
      case "newSession": {
        if (session.isStreaming) {
          await session.abort();
        }

        clearPendingChoices(ws, runtime, "Session changed");
        const { session: newSession } = await createWebUiSession(SessionManager.create(HOME_DIR, getSessionDir(HOME_DIR)), (request, signal) => waitForChoiceResponse(ws, runtime.pendingChoices!, request, signal));
        runtime.session = newSession;
        session = runtime.session;
        clearSessionListCache();
        setupSessionEvents(ws, runtime);
        send(ws, { type: "sessionChanged", sessionId: session.sessionId });
        send(ws, { type: "stateSync", state: serializeState(session) });
        console.log(`New session created: ${session.sessionId}`);
        break;
      }
      case "getMessages": {
        const page = messagePage(session, msg.offset, msg.limit);
        send(ws, { type: "messagePage", messages: page.messages, offset: page.offset, limit: page.limit, total: page.total, hasMoreBefore: page.hasMoreBefore });
        break;
      }
      case "getSessions": {
        const sessionPage = await listRecentSessions({ offset: msg.offset, limit: msg.limit, query: msg.query });
        send(ws, { type: "sessions", sessions: sessionPage.items, currentSessionId: session.sessionId, offset: sessionPage.offset, limit: sessionPage.limit, total: sessionPage.total, hasMore: sessionPage.hasMore, query: sessionPage.query });
        break;
      }
      case "renameSession": {
        const requestedPath = resolveSessionPath(msg.sessionPath);
        if (!requestedPath || !fs.existsSync(requestedPath)) {
          send(ws, { type: "error", message: "Session not found or outside the configured session directory" });
          return;
        }
        const name = msg.name.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 120);
        const currentSessionFile = session.sessionFile || "";
        const renamingCurrent = currentSessionFile !== "" && path.resolve(requestedPath) === path.resolve(currentSessionFile);
        if (renamingCurrent) {
          (session as any).setSessionName(name);
        } else {
          const manager = SessionManager.open(requestedPath, getSessionDir(HOME_DIR), HOME_DIR);
          manager.appendSessionInfo(name);
        }
        clearSessionListCache();
        if (renamingCurrent) send(ws, { type: "stateSync", state: serializeState(session) });
        const sessionPage = await listRecentSessions();
        send(ws, { type: "sessions", sessions: sessionPage.items, currentSessionId: session.sessionId, offset: sessionPage.offset, limit: sessionPage.limit, total: sessionPage.total, hasMore: sessionPage.hasMore, query: sessionPage.query });
        break;
      }
      case "loadSession": {
        if (session.isStreaming) {
          await session.abort();
        }

        const requestedPath = resolveSessionPath(msg.sessionPath);
        if (!requestedPath) {
          send(ws, { type: "error", message: "Refusing to load session outside the configured session directory" });
          return;
        }

        const loadedManager = SessionManager.open(requestedPath, getSessionDir(HOME_DIR), HOME_DIR);
        clearPendingChoices(ws, runtime, "Session changed");
        const { session: loadedSession } = await createWebUiSession(loadedManager, (request, signal) => waitForChoiceResponse(ws, runtime.pendingChoices!, request, signal));
        runtime.session = loadedSession;
        session = runtime.session;
        clearSessionListCache();
        setupSessionEvents(ws, runtime);
        send(ws, { type: "sessionChanged", sessionId: session.sessionId });
        send(ws, { type: "stateSync", state: serializeState(session) });
        console.log(`Loaded session: ${session.sessionId}`);
        break;
      }
    }
  } catch (err: any) {
    console.error(`Error handling ${msg.type}:`, err);
    send(ws, { type: "error", message: err.message || String(err) });
  }
}

app.get("/api/skills", requireEditAuth, async (_req, res) => {
  const skills = await listSkills();
  res.json({
    ok: true,
    userRoot: USER_SKILLS_DIR,
    sharedRoot: SHARED_SKILLS_DIR,
    skills: skills.map((skill) => ({ ...skill, path: skill.editable ? skill.path : undefined })),
  });
});

app.get("/api/skills/:source/:id", requireEditAuth, async (req, res) => {
  const result = await getSkillContent(String(req.params.source || ""), String(req.params.id || ""));
  if (!result) return res.status(404).json({ ok: false, error: "not_found" });
  const publicItem = result.item.editable ? result.item : { ...result.item, path: undefined };
  res.json({ ok: true, skill: publicItem, content: result.content });
});

app.post("/api/skills", requireEditAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim().toLowerCase();
  const description = normalizeSkillDescription(String(req.body?.description || ""));
  if (!isValidSkillName(name)) return res.status(400).json({ ok: false, error: "invalid_name", message: "Use lowercase letters, numbers, and single hyphens only." });
  if (!description || description.length > 1024) return res.status(400).json({ ok: false, error: "invalid_description", message: "Description is required and must be at most 1024 characters." });
  const skillFile = userSkillPath(name);
  if (!skillFile) return res.status(400).json({ ok: false, error: "invalid_name" });
  if (fs.existsSync(skillFile)) return res.status(409).json({ ok: false, error: "already_exists" });
  const escapedDescription = description.replaceAll('"', "'");
  const content = `---\nname: ${name}\ndescription: "${escapedDescription}"\n---\n\n# ${name}\n\n## When to use\n\n${description}\n\n## Instructions\n\n- Describe the workflow this skill should guide.\n- Add any setup, commands, references, or safety constraints the agent should follow.\n`;
  await writeSkillAtomic(skillFile, content);
  const item = await readSkillFile(skillFile, "user", true, createParsingState());
  res.json({ ok: true, skill: item, content, note: "Start a new session or reload the current one for Pi to advertise new/changed skills." });
});

app.put("/api/skills/user/:id", requireEditAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  const content = String(req.body?.content || "");
  if (!isValidSkillName(id)) return res.status(400).json({ ok: false, error: "invalid_name" });
  if (Buffer.byteLength(content, "utf8") > 100_000) return res.status(413).json({ ok: false, error: "content_too_large", message: "Skill content must be at most 100 KB." });
  const parsed = parseSkillFrontmatter(content);
  if (parsed.diagnostics.length > 0) return res.status(400).json({ ok: false, error: "invalid_skill", diagnostics: parsed.diagnostics });
  if (parsed.fields.name !== id) return res.status(400).json({ ok: false, error: "name_mismatch", message: "The frontmatter name must match the skill being edited. Create a new skill to rename." });
  const skillFile = userSkillPath(id);
  if (!skillFile || !fs.existsSync(skillFile)) return res.status(404).json({ ok: false, error: "not_found" });
  await writeSkillAtomic(skillFile, content);
  const item = await readSkillFile(skillFile, "user", true, createParsingState());
  res.json({ ok: true, skill: item, note: "Start a new session or reload the current one for Pi to advertise new/changed skills." });
});

app.delete("/api/skills/user/:id", requireEditAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  const skillFile = userSkillPath(id);
  if (!skillFile || !fs.existsSync(skillFile)) return res.status(404).json({ ok: false, error: "not_found" });
  await fs.promises.rm(path.dirname(skillFile), { recursive: true, force: true });
  res.json({ ok: true, note: "Deleted. Start a new session or reload the current one to remove it from advertised skills." });
});

// Serve static client files in production after API routes.
const clientDist = path.resolve(__dirname, "../dist");
app.use(express.static(clientDist));
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(clientDist, "client", "index.html"));
});

async function main() {
  console.log("Initializing Pi agent session...");

  if (!webUiToken && (!allowAnonymous || !anonymousLoopbackOnly)) {
    throw new Error("PI_WEBUI_TOKEN is required. Anonymous mode is allowed only when PI_WEBUI_ALLOW_ANONYMOUS=true and HOST is loopback.");
  }

  authStorage = AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
  modelRegistry = ModelRegistry.create(authStorage, path.join(AGENT_DIR, "models.json"));

  if (!litellmKey) {
    const key = await modelRegistry.getApiKeyForProvider("ollama");
    if (key) litellmKey = key;
  }

  wss.on("connection", async (ws, request) => {
    console.log(`Client connected (${clients.size + 1} total)`);

    try {
      const url = new URL(request.url || "/api/ws", `http://${request.headers.host || "localhost"}`);
      const sessionManager = sessionManagerForResumePath(url.searchParams.get("sessionPath") || undefined);
      const pendingChoices = new Map<string, PendingChoiceRequest>();
      const { session, modelFallbackMessage } = await createWebUiSession(sessionManager, (request, signal) => waitForChoiceResponse(ws, pendingChoices, request, signal));
      const runtime: ClientRuntime = { session, pendingChoices };
      clients.set(ws, runtime);

      if (modelFallbackMessage) {
        console.log("Model fallback:", modelFallbackMessage);
      }

      console.log(`Client session ${session.sessionId}: ${session.model?.provider}/${session.model?.id}, thinking ${session.thinkingLevel}, tools ${session.getActiveToolNames().join(", ")}`);
      setupSessionEvents(ws, runtime);

      send(ws, { type: "ready" });
      send(ws, { type: "stateSync", state: serializeState(session) });
    } catch (err: any) {
      console.error("Failed to create client session:", err);
      send(ws, { type: "error", message: err.message || String(err) });
      ws.close();
      return;
    }

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (!isClientMessage(parsed)) {
          send(ws, { type: "error", message: "Invalid client message" });
          return;
        }
        handleClientMessage(ws, parsed);
      } catch (err) {
        console.error("Invalid message:", err);
        send(ws, { type: "error", message: "Invalid JSON message" });
      }
    });

    ws.on("close", () => {
      const runtime = clients.get(ws);
      if (runtime?.unsubscribe) runtime.unsubscribe();
      if (runtime) clearPendingChoices(ws, runtime, "Client disconnected");
      if (runtime?.session.isStreaming) {
        runtime.session.abort().catch((err: any) => console.error("Abort on disconnect failed:", err));
      }
      clients.delete(ws);
      console.log(`Client disconnected (${clients.size} total)`);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Pi WebUI server listening on http://${HOST}:${PORT}`);

    if (webUiToken) {
      console.log("PI_WEBUI_TOKEN is required and enabled. Open the UI with ?token=<token> once; the client stores it in localStorage and then removes it from the URL.");
    }

    if (!webUiToken) {
      console.log("PI_WEBUI_ALLOW_ANONYMOUS=true is set on loopback; tokenless local development access is enabled.");
    }
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
