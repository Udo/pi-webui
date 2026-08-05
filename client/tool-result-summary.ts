function resultCount(value: any): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.count === "number") return value.count;
  for (const key of ["items", "rows", "shares", "recipes", "entries", "tasks"]) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  if (value.results && typeof value.results === "object" && !Array.isArray(value.results)) {
    const values = Object.values(value.results).filter((entry) => entry && typeof entry === "object");
    if (values.length === 1) return resultCount(values[0]);
  }
  if (Array.isArray(value.results)) return value.results.length;
  return undefined;
}

export function summarizeToolResultData(parsed: any, sdkError: boolean, textLength: number): string {
  const errorCode = parsed?.error || parsed?.code;
  const failed = sdkError || parsed?.ok === false || parsed?.type === "error" || Boolean(errorCode);
  const count = resultCount(parsed);
  const parts: string[] = [];
  if (failed) {
    const code = errorCode ? String(errorCode).replace(/\s+/g, " ").slice(0, 80) : "";
    parts.push(code ? `error: ${code}` : "error");
  }
  if (typeof count === "number") parts.push(`${count} item${count === 1 ? "" : "s"}`);
  if (parsed?.page?.has_more || parsed?.page?.hasMore) parts.push("more available");
  if (parsed?.truncated || parsed?.page?.truncated) parts.push("truncated");
  if (parts.length > 0) return parts.join(" · ");
  return textLength ? `${textLength.toLocaleString()} chars` : "no output";
}
