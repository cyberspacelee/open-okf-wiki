import assert from "node:assert/strict";
import test from "node:test";
import { classifyWikiAttemptFailure, decideWikiAgentTerminal } from "../dist/failures.js";
import { WikiTaskExecutionError } from "../dist/delegate-contracts.js";

test("terminal classification pauses quota and usage-limit after Pi returns", () => {
  assert.equal(decideWikiAgentTerminal(new Error("quota exceeded")).action, "pause");
  assert.equal(decideWikiAgentTerminal(new Error("usage limit reached")).action, "pause");
  assert.equal(decideWikiAgentTerminal(new WikiTaskExecutionError("schema", "schema")).action, "fail");
  assert.equal(decideWikiAgentTerminal(Object.assign(new Error("bad gateway"), { status: 502 })).action, "fail");
  const limited = classifyWikiAttemptFailure(Object.assign(new Error("limited"), { status: 429, retryAfterMs: 750 }));
  assert.equal(limited.code, "rate_limit");
  assert.equal(limited.retryable, false);
  assert.equal(limited.retryAfterMs, 750);
});
