import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolResultData } from "../client/tool-result-summary.ts";

test("summarizes generic result counts and pagination", () => {
  assert.equal(summarizeToolResultData({ items: [{}, {}], page: { has_more: true } }, false, 20), "2 items · more available");
  assert.equal(summarizeToolResultData({ results: { one: { rows: [{}] } }, truncated: true }, false, 20), "1 item · truncated");
});

test("summarizes errors without exposing an unbounded error code", () => {
  const code = "x".repeat(100);
  assert.equal(summarizeToolResultData({ error: code }, false, 0), `error: ${"x".repeat(80)}`);
  assert.equal(summarizeToolResultData({}, true, 0), "error");
});

test("uses output size only when structured data has no summary", () => {
  assert.equal(summarizeToolResultData({}, false, 1234), "1,234 chars");
  assert.equal(summarizeToolResultData({}, false, 0), "no output");
});
