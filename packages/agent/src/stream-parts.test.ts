import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSummary } from "./stream-parts.js";

test("sanitizeSummary redacts api keys", () => {
  const out = sanitizeSummary("using sk-proj-abcdefghijklmnopqrstuvwxyz and Bearer tok");
  assert.ok(out);
  assert.match(out!, /\[redacted-key\]/);
  assert.match(out!, /Bearer \[redacted\]/);
});
