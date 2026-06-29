import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "./app.css";

import { html, render, nothing } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Check, ChevronDown, Pencil, Plus, PanelLeftClose, Menu, X } from "lucide";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";

import {
  AssistantMessage,
  MessageList,
  MessageEditor,
  StreamingMessageContainer,
  formatUsage,
} from "@mariozechner/pi-web-ui";

void MessageList;
void MessageEditor;
void StreamingMessageContainer;
installAssistantMetadataRenderer();
import type {
  ClientMessage,
  ServerMessage,
  ModelInfo,
  SerializedAgentState,
  SessionListItem,
} from "../shared/protocol.js";

function toolResultText(result: ToolResultMessage | undefined): string {
  return result?.content
    ?.filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n") || "";
}

function prettyToolValue(value: unknown): { code: string; language: string } {
  try {
    if (typeof value === "string") return { code: JSON.stringify(JSON.parse(value), null, 2), language: "json" };
    return { code: JSON.stringify(value ?? {}, null, 2), language: "json" };
  } catch {
    return { code: typeof value === "string" ? value : String(value ?? ""), language: "text" };
  }
}

const toolCollapseOverrides = new Map<string, "full" | "collapsed">();
const autoCollapsedToolIds = new Set<string>();
const seenToolCallIds = new Set<string>();
let activeToolCallId = "";

type ToolProgressiveMode = "input" | "result" | "full" | "collapsed";

function toolArgsObject(args: any): Record<string, any> {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof args === "object" && !Array.isArray(args) ? args : {};
}

function truncateInline(text: string, max = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function summarizeToolCall(toolName: string, args: any): string {
  const p = toolArgsObject(args);
  if (toolName === "bash") return truncateInline(String(p.command || ""), 160);
  if (["read", "write", "edit"].includes(toolName)) return truncateInline(String(p.path || ""), 140);
  if (typeof p.query === "string" || typeof p.q === "string") return truncateInline(String(p.query || p.q), 140);
  return "";
}

function firstCount(value: any): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.length;
  for (const key of ["items", "rows", "results", "entries"]) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  for (const child of Object.values(value)) {
    const count = firstCount(child);
    if (count !== undefined) return count;
  }
  return undefined;
}

function summarizeToolResult(result: ToolResultMessage | undefined): string {
  if (!result) return "";
  const text = toolResultText(result);
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : result.details; } catch { parsed = result.details; }
  const count = firstCount(parsed);
  const parts = [];
  if (result.isError) parts.push("error");
  if (typeof count === "number") parts.push(`${count} item${count === 1 ? "" : "s"}`);
  if (parsed?.page?.has_more) parts.push("more available");
  if (parsed?.truncated || parsed?.page?.truncated) parts.push("truncated");
  if (parts.length > 0) return parts.join(" · ");
  return text ? `${text.length.toLocaleString()} chars` : "no output";
}

function allVisibleToolCallIds(): string[] {
  const ids: string[] = [];
  const scanMessage = (message: any) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part?.type === "toolCall" && typeof part.id === "string") ids.push(part.id);
    }
  };
  for (const message of messages) scanMessage(message);
  scanMessage(streamingMessage);
  return ids;
}

function progressiveToolMode(toolCallId: string, _hasResult: boolean): ToolProgressiveMode {
  const override = toolCollapseOverrides.get(toolCallId);
  return override === "full" ? "full" : "collapsed";
}

function collapsePreviousToolCallsFor(newToolCallId: string) {
  if (!newToolCallId || activeToolCallId === newToolCallId) return;
  for (const id of seenToolCallIds) {
    if (id !== newToolCallId && !toolCollapseOverrides.has(id)) autoCollapsedToolIds.add(id);
  }
  activeToolCallId = newToolCallId;
  autoCollapsedToolIds.delete(newToolCallId);
}

function noteVisibleToolCalls(message: any) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part?.type !== "toolCall" || typeof part.id !== "string" || seenToolCallIds.has(part.id)) continue;
    collapsePreviousToolCallsFor(part.id);
    seenToolCallIds.add(part.id);
  }
}

function renderProgressiveToolMessage(toolCall: any, result: ToolResultMessage | undefined, pending: boolean, aborted: boolean, isStreaming: boolean, host: any) {
  const effectiveResult = aborted ? ({ isError: true, content: [], toolCallId: toolCall.id, toolName: toolCall.name, timestamp: Date.now() } as any) : result;
  const mode = progressiveToolMode(toolCall.id, Boolean(effectiveResult));
  const args = toolArgsObject(toolCall.arguments);
  const commandInput = toolCall.name === "bash" && typeof args.command === "string" ? { code: args.command, language: "bash" } : undefined;
  const input = commandInput || prettyToolValue(toolCall.arguments);
  const outputText = toolResultText(effectiveResult) || (effectiveResult ? "(no output)" : "");
  const output = prettyToolValue(outputText);
  const status = effectiveResult ? (effectiveResult.isError ? "error" : "complete") : pending || isStreaming ? "running" : "waiting";
  const callSummary = summarizeToolCall(toolCall.name, toolCall.arguments);
  const resultSummary = summarizeToolResult(effectiveResult);
  const toggle = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    toolCollapseOverrides.set(toolCall.id, mode === "collapsed" ? "full" : "collapsed");
    host.requestUpdate();
  };
  const showInput = mode === "input" || mode === "full";
  const showResult = Boolean(effectiveResult) && (mode === "result" || mode === "full");

  return html`
    <div class="progressive-tool-card ${mode} ${status}">
      <button class="progressive-tool-header" type="button" @click=${toggle} aria-expanded=${mode !== "collapsed"}>
        <span class="progressive-tool-title">
          <span class="progressive-tool-status-dot"></span>
          <span>${toolCall.name}</span>
          ${callSummary ? html`<span class="progressive-tool-call-summary">${callSummary}</span>` : nothing}
        </span>
        <span class="progressive-tool-state">${resultSummary || status}</span>
      </button>
      ${mode === "collapsed" ? nothing : html`
        <div class="progressive-tool-body">
          ${showInput ? html`
            <div class="progressive-tool-section">
              <div class="progressive-tool-section-label">Input</div>
              <code-block .code=${input.code} language=${input.language}></code-block>
            </div>
          ` : effectiveResult ? html`
            <details class="progressive-tool-input-details">
              <summary>Input</summary>
              <code-block .code=${input.code} language=${input.language}></code-block>
            </details>
          ` : nothing}
          ${showResult ? html`
            <div class="progressive-tool-section">
              <div class="progressive-tool-section-label">Result</div>
              <code-block .code=${output.code} language=${output.language}></code-block>
            </div>
          ` : nothing}
        </div>
      `}
    </div>
  `;
}

function formatTokensPerSecond(message: any): string | undefined {
  const outputTokens = message?.usage?.output;
  const startedAt = message?.timestamp;
  const completedAt = message?.piWebuiCompletedAt;
  if (!outputTokens || !startedAt || !completedAt || completedAt <= startedAt) return undefined;
  const seconds = (completedAt - startedAt) / 1000;
  if (seconds <= 0) return undefined;
  return `${(outputTokens / seconds).toFixed(1)} tok/s`;
}

function messageModelLabel(provider: string | undefined, modelId: string | undefined): string {
  if (!provider || !modelId) return "";
  const matchingModel = availableModels.find((model) => model.provider === provider && model.id === modelId);
  if (matchingModel?.forceAliasLabel) return modelLabel(matchingModel);
  if (currentModel?.forceAliasLabel && currentModel.provider === provider && currentModel.id === modelId) return modelLabel(currentModel);
  return `${provider}/${modelId}`;
}

function assistantMetadata(message: any): string {
  const parts = [];
  const messageModel = messageModelLabel(message.provider, message.model);
  if (messageModel) parts.push(messageModel);
  if (message.usage) parts.push(formatUsage(message.usage));
  if (message.timestamp) parts.push(formatRelativeTime(new Date(message.timestamp).toISOString()));
  const tokensPerSecond = formatTokensPerSecond(message);
  if (tokensPerSecond) parts.push(tokensPerSecond);
  return parts.join(" · ");
}

function installAssistantMetadataRenderer() {
  // @mariozechner/pi-web-ui currently has no trailing-metadata slot/hook for
  // assistant messages, so this app overrides the component renderer locally.
  // Re-audit this copy after pi-web-ui updates, especially around chunk/tool rendering.
  (AssistantMessage.prototype as any).render = function () {
    const orderedParts = [];

    for (const chunk of this.message.content) {
      if (chunk.type === "text" && chunk.text.trim() !== "") {
        orderedParts.push(html`<markdown-block .content=${chunk.text}></markdown-block>`);
      } else if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
        orderedParts.push(html`<thinking-block .content=${chunk.thinking} .isStreaming=${this.isStreaming}></thinking-block>`);
      } else if (chunk.type === "toolCall" && !this.hideToolCalls) {
        const pending = this.pendingToolCalls?.has(chunk.id) ?? false;
        const result = this.toolResultsById?.get(chunk.id);
        if (this.hidePendingToolCalls && pending && !result) continue;
        const aborted = this.message.stopReason === "aborted" && !result;
        orderedParts.push(renderProgressiveToolMessage(chunk, result, pending, aborted, this.isStreaming, this));
      }
    }

    const metadata = this.message.usage && !this.isStreaming ? assistantMetadata(this.message) : "";
    return html`
      <div>
        ${orderedParts.length ? html`<div class="px-4 flex flex-col gap-3">${orderedParts}</div>` : nothing}
        ${metadata
          ? this.onCostClick
            ? html`<div class="px-4 mt-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${metadata}</div>`
            : html`<div class="px-4 mt-2 text-xs text-muted-foreground">${metadata}</div>`
          : nothing}
        ${this.message.stopReason === "error" && this.message.errorMessage
          ? html`<div class="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden"><strong>Error:</strong> ${this.message.errorMessage}</div>`
          : nothing}
        ${this.message.stopReason === "aborted" ? html`<span class="text-sm text-destructive italic">Request aborted</span>` : nothing}
      </div>
    `;
  };
}

// ── State ──

let ws: WebSocket | null = null;
let connected = false;
let agentReady = false;
let messages: AgentMessage[] = [];
let messagesOffset = 0;
let messagesTotal = 0;
let hasMoreMessagesBefore = false;
let messagesLoadingOlder = false;
let isStreaming = false;
let streamingMessage: AgentMessage | null = null;
let currentModel: ModelInfo | undefined;
let thinkingLevel = "off";
let availableModels: ModelInfo[] = [];
let errorMessage: string | undefined;
let showModelDropdown = false;
let modelFilter = "";
let showAllModels = false;
let toolNames: string[] = [];
let currentSessionId = "";
let currentSessionName: string | undefined;
let currentSessionPath: string | undefined;
let errorClearTimer: number | undefined;
let sidebarOpen = false;
let sessionList: SessionListItem[] = [];
let sessionsLoading = false;
let sessionsLoadingMore = false;
let sessionsHasMore = false;
let sessionsOffset = 0;
let sessionSearch = "";
let sessionSearchTimer: number | undefined;
let editingSessionPath: string | undefined;
let editingSessionName = "";
let pendingChoice: any | null = null;
let pendingChoiceSelected = new Set<string>();

// ── WebSocket ──

function getWebUiToken(): string {
  const params = new URLSearchParams(location.search);
  const queryToken = params.get("token") || "";
  const token = queryToken || localStorage.getItem("pi-webui-token") || "";
  if (token) {
    localStorage.setItem("pi-webui-token", token);
  }
  if (queryToken) {
    removeTokenFromLocation(params);
  }
  return token;
}

function removeTokenFromLocation(params: URLSearchParams) {
  params.delete("token");
  const query = params.toString();
  const nextUrl = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
  history.replaceState(history.state, "", nextUrl);
}

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = getWebUiToken();
  const lastPath = localStorage.getItem("pi-webui-session-path") || "";
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (lastPath) params.set("sessionPath", lastPath);
  const query = params.toString() ? `?${params.toString()}` : "";
  return `${proto}//${location.host}/api/ws${query}`;
}

function connectWs() {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    connected = true;
    agentReady = false;
    renderApp();
  };

  ws.onclose = () => {
    connected = false;
    agentReady = false;
    ws = null;
    sessionsLoading = false;
    renderApp();
    setTimeout(connectWs, 2000);
  };

  ws.onerror = () => {
    ws?.close();
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as ServerMessage;
      handleServerMessage(msg);
    } catch (err) {
      console.error("Invalid server message:", err);
      errorMessage = "Invalid server message";
      renderApp();
    }
  };
}

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "ready": {
      agentReady = true;
      send({ type: "getModels" });
      if (sidebarOpen) {
        requestSessions(true);
      }
      renderApp();
      break;
    }

    case "stateSync":
      applyStateSync(msg.state);
      break;

    case "agentEvent":
      handleAgentEvent(msg.event);
      break;

    case "models":
      availableModels = msg.models;
      if (msg.current) currentModel = msg.current;
      if (msg.thinkingLevel) thinkingLevel = msg.thinkingLevel;
      renderApp();
      break;

    case "modelChanged":
      currentModel = msg.model;
      thinkingLevel = msg.thinkingLevel;
      renderApp();
      break;

    case "error":
      errorMessage = msg.message;
      sessionsLoading = false;
      if (errorClearTimer) window.clearTimeout(errorClearTimer);
      renderApp();
      errorClearTimer = window.setTimeout(() => {
        errorMessage = undefined;
        errorClearTimer = undefined;
        renderApp();
      }, 5000);
      break;

    case "sessions":
      sessionList = (msg.offset || 0) > 0 ? [...sessionList, ...msg.sessions] : msg.sessions;
      currentSessionId = msg.currentSessionId;
      sessionsOffset = (msg.offset || 0) + msg.sessions.length;
      sessionsHasMore = Boolean(msg.hasMore);
      sessionsLoading = false;
      sessionsLoadingMore = false;
      if (typeof msg.query === "string" && msg.query !== sessionSearch) sessionSearch = msg.query;
      renderApp();
      break;

    case "messagePage": {
      const scrollEl = document.getElementById("messages-scroll");
      const previousHeight = scrollEl?.scrollHeight || 0;
      messages = [...msg.messages, ...messages];
      messagesOffset = msg.offset;
      messagesTotal = msg.total;
      hasMoreMessagesBefore = msg.hasMoreBefore;
      messagesLoadingOlder = false;
      renderApp();
      requestAnimationFrame(() => {
        const nextScrollEl = document.getElementById("messages-scroll");
        if (nextScrollEl) nextScrollEl.scrollTop = nextScrollEl.scrollHeight - previousHeight;
      });
      break;
    }

    case "sessionChanged":
      currentSessionId = msg.sessionId;
      renderApp();
      requestAnimationFrame(() => scrollMessagesToBottom(true));
      break;
  }
}

function applyStateSync(state: SerializedAgentState) {
  const incomingOffset = state.messagesOffset || 0;
  if (currentSessionId === state.sessionId && messagesOffset < incomingOffset && messages.length > 0) {
    const prefixCount = Math.max(0, incomingOffset - messagesOffset);
    messages = [...messages.slice(0, prefixCount), ...state.messages];
  } else {
    messages = state.messages;
    messagesOffset = incomingOffset;
  }
  messagesTotal = state.messagesTotal ?? messages.length;
  hasMoreMessagesBefore = Boolean(state.hasMoreMessagesBefore);
  messagesLoadingOlder = false;
  isStreaming = state.isStreaming;
  streamingMessage = state.streamingMessage || null;
  thinkingLevel = state.thinkingLevel;
  toolNames = state.tools;
  if (state.model) currentModel = state.model;
  if (state.errorMessage) errorMessage = state.errorMessage;
  if (currentSessionId && currentSessionId !== state.sessionId) {
    toolCollapseOverrides.clear();
    autoCollapsedToolIds.clear();
    seenToolCallIds.clear();
    activeToolCallId = "";
  }
  currentSessionId = state.sessionId;
  currentSessionName = state.sessionName;
  currentSessionPath = state.sessionPath;
  if (currentSessionPath) {
    localStorage.setItem("pi-webui-session-path", currentSessionPath);
  }
  renderApp();
  requestAnimationFrame(() => scrollMessagesToBottom(!isStreaming));
}

function handleAgentEvent(event: any) {
  switch (event.type) {
    case "agent_start":
      isStreaming = true;
      renderApp();
      break;

    case "agent_end":
      isStreaming = false;
      streamingMessage = null;
      updateStreamingContainer(null, false);
      renderApp();
      break;

    case "message_start":
      renderApp();
      break;

    case "message_update":
      noteVisibleToolCalls(event.message);
      streamingMessage = event.message;
      updateStreamingContainer(event.message, true);
      requestAnimationFrame(() => scrollMessagesToBottom(true));
      break;

    case "message_end":
      noteVisibleToolCalls(event.message);
      if (event.message) {
        const existing = messages.findIndex(
          (m: any) => m.timestamp === (event.message as any).timestamp && m.role === event.message.role
        );
        if (existing === -1) {
          messages = [...messages, event.message];
        }
      }
      streamingMessage = null;
      updateStreamingContainer(null, true);
      renderApp();
      break;

    case "turn_start":
      renderApp();
      break;

    case "turn_end":
      if (event.toolResults) {
        for (const tr of event.toolResults) {
          const existing = messages.findIndex(
            (m: any) => m.role === "toolResult" && m.toolCallId === (tr as ToolResultMessage).toolCallId
          );
          if (existing === -1) {
            messages = [...messages, tr];
          }
        }
      }
      renderApp();
      break;

    case "choice_request":
      pendingChoice = event.request;
      pendingChoiceSelected = new Set();
      renderApp();
      requestAnimationFrame(() => scrollMessagesToBottom(true));
      break;
    case "choice_resolved":
      if (pendingChoice?.id === event.requestId) {
        pendingChoice = null;
        pendingChoiceSelected = new Set();
      }
      renderApp();
      break;
    case "tool_execution_start":
      if (typeof event.toolCallId === "string" && !seenToolCallIds.has(event.toolCallId)) {
        collapsePreviousToolCallsFor(event.toolCallId);
        seenToolCallIds.add(event.toolCallId);
      }
      renderApp();
      break;
    case "tool_execution_update":
    case "tool_execution_end":
      renderApp();
      break;
  }
}

function updateStreamingContainer(message: AgentMessage | null, streaming: boolean) {
  const container = document.querySelector("streaming-message-container") as StreamingMessageContainer | null;
  if (container) {
    container.isStreaming = streaming;
    container.setMessage(message, !streaming);
  }
}

function requestOlderMessages() {
  if (!agentReady || messagesLoadingOlder || !hasMoreMessagesBefore || messagesOffset <= 0) return;
  messagesLoadingOlder = true;
  const nextOffset = Math.max(0, messagesOffset - 60);
  send({ type: "getMessages", offset: nextOffset, limit: messagesOffset - nextOffset });
  renderApp();
}

function handleMessagesScroll(event: Event) {
  const el = event.currentTarget as HTMLElement;
  if (el.scrollTop < 160) requestOlderMessages();
}

function scrollMessagesToBottom(force = false) {
  const scrollEl = document.getElementById("messages-scroll");
  if (!scrollEl) return;
  const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  if (force || distanceFromBottom < 150) {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }
}

// ── User actions ──

function handleSend(input: string) {
  if (!input.trim() || isStreaming) return;
  send({ type: "prompt", text: input });

  const editor = document.querySelector("message-editor") as MessageEditor | null;
  if (editor) {
    editor.value = "";
    editor.attachments = [];
  }
}

function handleAbort() {
  send({ type: "abort" });
}

function handleModelSelect(model: ModelInfo) {
  send({ type: "setModel", provider: model.provider, modelId: model.id });
  showModelDropdown = false;
  renderApp();
}

function handleThinkingChange(level: string) {
  send({ type: "setThinkingLevel", level });
}

function toggleModelDropdown() {
  showModelDropdown = !showModelDropdown;
  modelFilter = "";
  showAllModels = false;
  renderApp();
  if (showModelDropdown) {
    requestAnimationFrame(() => {
      document.getElementById("model-filter")?.focus();
    });
  }
}

function handleNewSession() {
  send({ type: "newSession" });
  renderApp();
}

function requestSessions(reset = true) {
  if (!agentReady) return;
  if (reset) {
    sessionsLoading = true;
    sessionsLoadingMore = false;
    sessionsOffset = 0;
    send({ type: "getSessions", offset: 0, limit: 30, query: sessionSearch });
  } else if (sessionsHasMore && !sessionsLoading && !sessionsLoadingMore) {
    sessionsLoadingMore = true;
    send({ type: "getSessions", offset: sessionsOffset, limit: 30, query: sessionSearch });
  }
  renderApp();
}

function handleSessionSearchInput(event: Event) {
  sessionSearch = (event.target as HTMLInputElement).value;
  if (sessionSearchTimer) window.clearTimeout(sessionSearchTimer);
  sessionSearchTimer = window.setTimeout(() => {
    sessionSearchTimer = undefined;
    requestSessions(true);
  }, 250);
  renderApp();
}

function handleSessionListScroll(event: Event) {
  const el = event.currentTarget as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) requestSessions(false);
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) requestSessions(true);
  renderApp();
}

function closeSidebar() {
  sidebarOpen = false;
  renderApp();
}

function handleLoadSession(sessionPath: string) {
  if (sessionPath === currentSessionPath) return;
  send({ type: "loadSession", sessionPath });
}

function startRenameSession(event: Event, session: SessionListItem) {
  event.preventDefault();
  event.stopPropagation();
  editingSessionPath = session.path;
  editingSessionName = session.name || sessionTitle(session);
  renderApp();
  requestAnimationFrame(() => {
    const input = document.getElementById(`session-rename-${session.id}`) as HTMLInputElement | null;
    input?.focus();
    input?.select();
  });
}

function cancelRenameSession(event?: Event) {
  event?.preventDefault();
  event?.stopPropagation();
  editingSessionPath = undefined;
  editingSessionName = "";
  renderApp();
}

function submitRenameSession(event: Event, session: SessionListItem) {
  event.preventDefault();
  event.stopPropagation();
  const name = editingSessionName.trim();
  if (!name) return cancelRenameSession(event);
  send({ type: "renameSession", sessionPath: session.path, name });
  editingSessionPath = undefined;
  editingSessionName = "";
  renderApp();
}

function handleRenameKey(event: KeyboardEvent, session: SessionListItem) {
  if (event.key === "Enter") submitRenameSession(event, session);
  if (event.key === "Escape") cancelRenameSession(event);
}

document.addEventListener("click", (e) => {
  if (showModelDropdown) {
    const dropdown = document.getElementById("model-dropdown");
    const trigger = document.getElementById("model-trigger");
    if (dropdown && !dropdown.contains(e.target as Node) && !trigger?.contains(e.target as Node)) {
      showModelDropdown = false;
      renderApp();
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sidebarOpen) {
    closeSidebar();
  }
});

// ── Render ──

function buildToolResultsMap(): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const msg of messages) {
    if ((msg as any).role === "toolResult") {
      map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
    }
  }
  return map;
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function truncateText(text: string, maxLen: number): string {
  if (!text) return "";
  const cleaned = text.replace(/\n/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
}

function sessionTitle(s: SessionListItem): string {
  if (s.name) return s.name;
  if (s.firstMessage) return truncateText(s.firstMessage, 60);
  return `Session ${s.id.slice(0, 8)}`;
}

function modelLabel(model: ModelInfo): string {
  if (model.forceAliasLabel) return model.name || model.id;
  return `${model.provider}/${model.id}`;
}

function modelMatchesFilter(model: ModelInfo, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return [model.provider, model.id, model.name, modelLabel(model)]
    .some((value) => value.toLowerCase().includes(needle));
}

function renderSidebar() {
  return html`
    <div class="sidebar-inner h-full flex flex-col">
      <div class="sidebar-header">
        <span class="sidebar-title">Sessions</span>
        <div style="display:flex;align-items:center;gap:4px">
          <button class="icon-button" title="New session" @click=${handleNewSession}>${icon(Plus, "sm")}</button>
          <button class="icon-button" title="Close sidebar" @click=${closeSidebar}>${icon(PanelLeftClose, "sm")}</button>
        </div>
      </div>

      <div class="sidebar-search">
        <input
          class="sidebar-search-input"
          type="search"
          placeholder="Search conversations..."
          .value=${sessionSearch}
          @input=${handleSessionSearchInput}
        />
      </div>

      <div class="flex-1 overflow-y-auto" @scroll=${handleSessionListScroll}>
        ${sessionsLoading && sessionList.length === 0 ? html`
          <div class="sidebar-empty">
            Loading sessions...
          </div>
        ` : sessionList.length === 0 && (!connected || !agentReady) ? html`
          <div class="sidebar-empty">
            Connecting...
          </div>
        ` : sessionList.length === 0 ? html`
          <div class="sidebar-empty">
            ${sessionSearch ? "No matching sessions" : "No sessions found"}
          </div>
        ` : html`
          ${sessionList.map((s) => html`
            <div class="session-item-row ${s.id === currentSessionId ? 'active' : ''}">
              ${editingSessionPath === s.path ? html`
                <form class="session-rename-form" @submit=${(event: Event) => submitRenameSession(event, s)} @click=${(event: Event) => event.stopPropagation()}>
                  <input
                    id="session-rename-${s.id}"
                    class="session-rename-input"
                    .value=${editingSessionName}
                    maxlength="120"
                    @input=${(event: Event) => { editingSessionName = (event.target as HTMLInputElement).value; }}
                    @keydown=${(event: KeyboardEvent) => handleRenameKey(event, s)}
                  />
                  <button class="session-action-button" type="submit" title="Save name" aria-label="Save conversation name">${icon(Check, "sm")}</button>
                  <button class="session-action-button" type="button" title="Cancel rename" aria-label="Cancel rename" @click=${cancelRenameSession}>${icon(X, "sm")}</button>
                </form>
              ` : html`
                <button
                  class="session-item"
                  @click=${() => handleLoadSession(s.path)}
                >
                  <div class="session-item-title">${sessionTitle(s)}</div>
                  ${s.name && s.firstMessage ? html`
                    <div class="session-item-preview">${truncateText(s.firstMessage, 80)}</div>
                  ` : nothing}
                  <div class="session-item-meta">
                    <span>${s.messageCount} messages</span>
                    <span>${formatRelativeTime(s.modified)}</span>
                  </div>
                </button>
                <button
                  class="session-action-button"
                  type="button"
                  title="Rename conversation"
                  aria-label="Rename conversation ${sessionTitle(s)}"
                  @click=${(event: Event) => startRenameSession(event, s)}
                >${icon(Pencil, "sm")}</button>
              `}
            </div>
          `)}
          ${sessionsLoadingMore ? html`<div class="sidebar-empty sidebar-loading-more">Loading more...</div>` : nothing}
          ${sessionsHasMore && !sessionsLoadingMore ? html`<button class="sidebar-load-more" type="button" @click=${() => requestSessions(false)}>Load more</button>` : nothing}
        `}
      </div>
    </div>
  `;
}

function submitChoiceResponse(request: any, selected: string[]) {
  if (selected.length === 0) return;
  send({ type: "choiceResponse", requestId: String(request.id), selected });
  pendingChoice = null;
  pendingChoiceSelected = new Set();
  renderApp();
}

function togglePendingChoice(choiceId: string) {
  const next = new Set(pendingChoiceSelected);
  if (next.has(choiceId)) next.delete(choiceId);
  else next.add(choiceId);
  pendingChoiceSelected = next;
  renderApp();
}

function renderChoiceRequest() {
  if (!pendingChoice) return nothing;
  const choices = pendingChoice.choices || [];
  return html`
    <div class="choice-request-card" role="group" aria-label="Agent choice request">
      <div class="choice-request-title">${pendingChoice.prompt || "Please choose an option."}</div>
      <div class="choice-request-options">
        ${choices.map((choice: any) => pendingChoice.allowMultiple ? html`
          <button class="choice-request-option ${pendingChoiceSelected.has(choice.id) ? 'selected' : ''}" type="button" @click=${() => togglePendingChoice(choice.id)}>
            <span class="choice-request-label">${pendingChoiceSelected.has(choice.id) ? '☑' : '☐'} ${choice.label || choice.id}</span>
            ${choice.description ? html`<span class="choice-request-description">${choice.description}</span>` : nothing}
          </button>
        ` : html`
          <button class="choice-request-option" type="button" @click=${() => submitChoiceResponse(pendingChoice, [choice.id])}>
            <span class="choice-request-label">${choice.label || choice.id}</span>
            ${choice.description ? html`<span class="choice-request-description">${choice.description}</span>` : nothing}
          </button>
        `)}
      </div>
      ${pendingChoice.allowMultiple ? html`
        <button class="choice-request-submit" type="button" ?disabled=${pendingChoiceSelected.size === 0} @click=${() => submitChoiceResponse(pendingChoice, Array.from(pendingChoiceSelected))}>Send choice</button>
      ` : nothing}
    </div>
  `;
}

function renderApp() {
  const app = document.getElementById("app");
  if (!app) return;

  const toolResultsById = buildToolResultsMap();

  const appHtml = html`
    <!-- Mobile sidebar overlay -->
    <div
      class="sidebar-overlay ${sidebarOpen ? 'open' : ''}"
      @click=${closeSidebar}
    ></div>

    <!-- Sidebar panel -->
    <div class="sidebar-panel ${sidebarOpen ? 'open' : ''}">
      ${renderSidebar()}
    </div>

    <!-- Main content -->
    <div class="main-content flex flex-col h-full bg-background text-foreground min-w-0 flex-1">
      <!-- Header -->
      <div class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 overflow-visible">
        <button
          class="p-1.5 rounded hover:bg-accent transition-colors shrink-0"
          title="${sidebarOpen ? 'Close sidebar' : 'Open sessions'}"
          @click=${toggleSidebar}
        >
          ${sidebarOpen ? icon(PanelLeftClose, "sm") : icon(Menu, "sm")}
        </button>

        <span class="font-semibold text-sm shrink-0 hidden sm:inline">Pi Web UI</span>

        <span class="status-pill px-1.5 py-0.5 rounded-full shrink-0 ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}">
          ${connected ? "Connected" : "Disconnected"}
        </span>

        <div class="flex-1"></div>

        <!-- Model selector -->
        <div class="relative shrink-0">
          <button
            id="model-trigger"
            class="model-button flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-accent transition-colors"
            @click=${toggleModelDropdown}
          >
            <span class="max-w-[180px] sm:max-w-[280px] truncate">${currentModel ? modelLabel(currentModel) : "No model"}</span>
            ${icon(ChevronDown, "xs")}
          </button>
          ${showModelDropdown ? (() => {
            const scopedModels = availableModels.filter((m) => m.scoped);
            const sourceModels = showAllModels || scopedModels.length === 0 ? availableModels : scopedModels;
            const sorted = [...sourceModels].sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)));
            const filtered = sorted.filter((m) => modelMatchesFilter(m, modelFilter));
            return html`
            <div
              id="model-dropdown"
              class="fixed right-4 mt-1 z-[200] w-[32rem] max-w-[calc(100vw-2rem)] max-h-96 flex flex-col rounded-md border border-border bg-popover shadow-lg"
            >
              <div class="p-1.5 border-b border-border shrink-0">
                <div class="model-scope-row">
                  <span>${showAllModels || scopedModels.length === 0 ? `All models (${availableModels.length})` : `Scoped models (${scopedModels.length})`}</span>
                  ${scopedModels.length > 0 ? html`
                    <button
                      class="model-scope-toggle"
                      @click=${() => { showAllModels = !showAllModels; renderApp(); }}
                    >
                      ${showAllModels ? "Show scoped" : "Show all"}
                    </button>
                  ` : nothing}
                </div>
                <input
                  id="model-filter"
                  type="text"
                  placeholder="Filter models..."
                  class="model-filter w-full px-2 py-1 rounded border border-border bg-background text-foreground outline-none"
                  .value=${modelFilter}
                  @input=${(e: Event) => { modelFilter = (e.target as HTMLInputElement).value; renderApp(); requestAnimationFrame(() => document.getElementById("model-filter")?.focus()); }}
                  @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { showModelDropdown = false; renderApp(); }}}
                />
              </div>
              <div class="overflow-y-auto flex-1">
                ${filtered.map(
                  (m) => html`
                    <button
                      class="model-option w-full text-left px-3 py-2 hover:bg-accent transition-colors ${m.provider === currentModel?.provider && m.id === currentModel?.id ? 'model-option-current' : ''}"
                      @click=${() => handleModelSelect(m)}
                    >
                      ${modelLabel(m)}
                    </button>
                  `
                )}
                ${filtered.length === 0 ? html`<div class="model-option px-3 py-2 text-muted-foreground">No matches</div>` : ""}
              </div>
            </div>
          `; })() : ""}
        </div>

        <!-- Thinking level -->
        <select
          class="thinking-select text-xs px-1.5 py-1 rounded border border-border bg-background shrink-0"
          .value=${thinkingLevel}
          @change=${(e: Event) => handleThinkingChange((e.target as HTMLSelectElement).value)}
        >
          <option value="off">No thinking</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>

        ${toolNames.length > 0 ? html`
          <span class="text-[10px] text-muted-foreground shrink-0 hidden sm:inline" title=${toolNames.join(", ")}>
            ${toolNames.length} tools
          </span>
        ` : ""}

        <theme-toggle class="shrink-0"></theme-toggle>
      </div>

      <!-- Error banner -->
      ${errorMessage ? html`
        <div class="px-4 py-2 bg-destructive/10 text-destructive text-sm border-b border-destructive/20">
          ${errorMessage}
        </div>
      ` : ""}

      <!-- Messages area -->
      <div class="flex-1 overflow-y-auto px-3 sm:px-4 py-4" id="messages-scroll" @scroll=${handleMessagesScroll}>
        ${messages.length === 0 && !isStreaming ? html`
          <div class="flex items-center justify-center h-full text-muted-foreground text-sm">
            Send a message to start a conversation
          </div>
        ` : html`
          <div class="max-w-4xl mx-auto flex flex-col gap-3">
            ${hasMoreMessagesBefore ? html`
              <button class="message-load-older" type="button" @click=${requestOlderMessages} ?disabled=${messagesLoadingOlder}>
                ${messagesLoadingOlder ? "Loading earlier messages..." : `Load earlier messages (${messagesOffset} older)`}
              </button>
            ` : nothing}
            <message-list
              .messages=${messages}
              .tools=${[]}
              .pendingToolCalls=${new Set()}
              .isStreaming=${isStreaming}
            ></message-list>

            <streaming-message-container
              class="${isStreaming ? '' : 'hidden'}"
              .tools=${[]}
              .isStreaming=${isStreaming}
              .pendingToolCalls=${new Set()}
              .toolResultsById=${toolResultsById}
            ></streaming-message-container>
            ${renderChoiceRequest()}
          </div>
        `}
      </div>

      <!-- Input area -->
      <div class="border-t border-border px-3 sm:px-4 py-2 sm:py-3 shrink-0">
        <div class="max-w-4xl mx-auto">
          <message-editor
            .isStreaming=${isStreaming}
            .currentModel=${currentModel ? { provider: currentModel.provider, id: currentModel.id, name: currentModel.name } as any : undefined}
            .thinkingLevel=${thinkingLevel}
            .showAttachmentButton=${false}
            .showModelSelector=${false}
            .showThinkingSelector=${false}
            .onSend=${(input: string) => handleSend(input)}
            .onAbort=${() => handleAbort()}
          ></message-editor>
        </div>
      </div>
    </div>
  `;

  render(appHtml, app);

  if (isStreaming) {
    scrollMessagesToBottom();
  }
}

// ── Init ──

renderApp();
connectWs();
