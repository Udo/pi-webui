// ── Client → Server messages ──

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "followUp"; text: string }
  | { type: "abort" }
  | { type: "getModels" }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: string }
  | { type: "getState" }
  | { type: "newSession" }
  | { type: "getSessions"; offset?: number; limit?: number; query?: string }
  | { type: "getMessages"; offset: number; limit?: number }
  | { type: "loadSession"; sessionPath: string }
  | { type: "renameSession"; sessionPath: string; name: string }
  | { type: "choiceResponse"; requestId: string; selected: string[] };

// ── Server → Client messages ──

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  scoped?: boolean;
  forceAliasLabel?: boolean;
}

export interface SessionListItem {
  id: string;
  path: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export type ServerMessage =
  | { type: "agentEvent"; event: any }
  | { type: "stateSync"; state: SerializedAgentState }
  | { type: "models"; models: ModelInfo[]; current?: ModelInfo; thinkingLevel?: string }
  | { type: "modelChanged"; model: ModelInfo; thinkingLevel: string }
  | { type: "error"; message: string }
  | { type: "ready" }
  | { type: "sessions"; sessions: SessionListItem[]; currentSessionId: string; offset?: number; limit?: number; total?: number; hasMore?: boolean; query?: string }
  | { type: "messagePage"; messages: any[]; offset: number; limit: number; total: number; hasMoreBefore: boolean }
  | { type: "sessionChanged"; sessionId: string };

export interface SerializedAgentState {
  messages: any[];
  messagesOffset?: number;
  messagesTotal?: number;
  hasMoreMessagesBefore?: boolean;
  model?: ModelInfo;
  thinkingLevel: string;
  systemPrompt: string;
  isStreaming: boolean;
  streamingMessage?: any;
  errorMessage?: string;
  tools: string[];
  sessionId: string;
  sessionName?: string;
  sessionPath?: string;
}
