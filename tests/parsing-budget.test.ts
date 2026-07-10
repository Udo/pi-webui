import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReadFile,
  createParsingState,
  markStopped,
  parseDepthIsAllowed,
  recordRead,
  type ParsingLimits,
} from "../server/parsing-budget.js";

test("allows reads within limits", () => {
  const state = createParsingState();
  const limits: ParsingLimits = { maxFiles: 2, maxBytesTotal: 100, maxBytesPerFile: 60 };

  assert.equal(canReadFile(40, limits, state).canRead, true);
  recordRead(40, state);
  assert.equal(canReadFile(40, limits, state).canRead, true);
  recordRead(40, state);
  assert.equal(canReadFile(1, limits, state).canRead, false);
  assert.equal(state.files, 2);
  assert.equal(state.bytes, 80);
});

test("stops when request byte budget is exceeded", () => {
  const state = createParsingState();
  const limits: ParsingLimits = { maxFiles: 10, maxBytesTotal: 100, maxBytesPerFile: 60 };

  assert.deepEqual(canReadFile(50, limits, state), {
    canRead: true,
    stop: false,
  });
  recordRead(50, state);
  const decision = canReadFile(60, limits, state);
  assert.equal(decision.canRead, false);
  assert.equal(decision.stop, true);
  assert.equal(decision.reason, "request-byte-limit");
  assert.equal(state.files, 1);
});

test("skips oversized files but keeps scanning", () => {
  const state = createParsingState();
  const limits: ParsingLimits = { maxFiles: 2, maxBytesTotal: 100, maxBytesPerFile: 40 };
  assert.deepEqual(canReadFile(99, limits, state), {
    canRead: false,
    stop: false,
    reason: "file-byte-limit",
  });
  assert.equal(canReadFile(20, limits, state).canRead, true);
});

test("tracks depth limits", () => {
  const depthLimit = 3;
  assert.equal(parseDepthIsAllowed(1, depthLimit), true);
  assert.equal(parseDepthIsAllowed(3, depthLimit), true);
  assert.equal(parseDepthIsAllowed(4, depthLimit), false);
});

test("marks stopped state", () => {
  const state = createParsingState();
  markStopped(state, "file-count-limit");
  assert.equal(state.stopReason, "file-count-limit");
});
