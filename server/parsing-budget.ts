export type ParsingStopReason = "file-count-limit" | "request-byte-limit" | "file-byte-limit";

export interface ParsingLimits {
  maxFiles: number;
  maxBytesTotal: number;
  maxBytesPerFile: number;
}

export interface ParsingState {
  files: number;
  bytes: number;
  stopReason: ParsingStopReason | undefined;
}

export interface ParsingDecision {
  canRead: boolean;
  stop: boolean;
  reason?: ParsingStopReason;
}

export function createParsingState(): ParsingState {
  return {
    files: 0,
    bytes: 0,
    stopReason: undefined,
  };
}

export function canReadFile(sizeBytes: number, limits: ParsingLimits, state: ParsingState): ParsingDecision {
  if (limits.maxBytesPerFile > 0 && sizeBytes > limits.maxBytesPerFile) {
    return { canRead: false, stop: false, reason: "file-byte-limit" };
  }

  if (limits.maxFiles > 0 && state.files >= limits.maxFiles) {
    return { canRead: false, stop: true, reason: "file-count-limit" };
  }

  if (limits.maxBytesTotal > 0 && state.bytes + sizeBytes > limits.maxBytesTotal) {
    return { canRead: false, stop: true, reason: "request-byte-limit" };
  }

  return { canRead: true, stop: false };
}

export function recordRead(sizeBytes: number, state: ParsingState) {
  state.files += 1;
  state.bytes += Math.max(0, sizeBytes);
}

export function markStopped(state: ParsingState, reason: ParsingStopReason) {
  state.stopReason = reason;
}

export function parseDepthIsAllowed(currentDepth: number, maxDepth: number): boolean {
  if (maxDepth <= 0) return true;
  return currentDepth <= maxDepth;
}
