import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_KICKOFF_TEXT,
  expandChatSlash,
  helpTextForSessionTurn,
  isKickoff,
  isKickoffPhrase,
  normalizeSessionUserText,
  resolveSessionTurnMode,
} from "./session-policy.js";

test("expandChatSlash chat-bound names", () => {
  assert.equal(expandChatSlash("generate"), DEFAULT_KICKOFF_TEXT);
  assert.equal(expandChatSlash("run", "overview only"), "overview only");
  assert.equal(expandChatSlash("approve"), "approve");
  assert.equal(expandChatSlash("deny"), "deny");
  assert.equal(expandChatSlash("reject"), "deny");
  assert.equal(expandChatSlash("reset"), null);
  assert.equal(expandChatSlash("help"), null);
});

test("isKickoff / isKickoffPhrase", () => {
  assert.equal(isKickoff("generate a wiki plan", "idle"), true);
  assert.equal(isKickoff("hello", "idle"), false);
  assert.equal(isKickoff("generate", "awaiting_plan"), false);
  assert.equal(isKickoffPhrase("/generate"), true);
  assert.equal(isKickoffPhrase("hello"), false);
});

test("normalizeSessionUserText", () => {
  assert.equal(normalizeSessionUserText("/generate"), DEFAULT_KICKOFF_TEXT);
  assert.equal(normalizeSessionUserText("/approve"), "approve");
  assert.equal(normalizeSessionUserText("/deny"), "deny");
  assert.equal(normalizeSessionUserText("hello"), "hello");
});

test("resolveSessionTurnMode", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "approve",
      phase: "awaiting_plan",
      status: "waiting",
      hasSources: true,
      resumeData: { action: "approve" },
      existingRunId: "run-1",
    }),
    { mode: "resume" },
  );
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "generate",
      phase: "idle",
      status: "active",
      hasSources: true,
    }),
    { mode: "start" },
  );
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "hello",
      phase: "idle",
      status: "active",
      hasSources: true,
    }),
    { mode: "help", helpReason: "not_kickoff" },
  );
});

test("helpTextForSessionTurn no_sources", () => {
  assert.match(
    helpTextForSessionTurn({ helpReason: "no_sources" }),
    /Sources/,
  );
});
