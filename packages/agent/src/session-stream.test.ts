import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import {
  helpTextForSessionTurn,
  isKickoff,
  isKickoffPhrase,
  normalizeSessionUserText,
  resolveSessionTurnMode,
  sessionMessagesToUIMessages,
  uiMessagesToSessionMessages,
} from "./session-stream.js";

test("isKickoff requires generate-ish phrase on idle/done only", () => {
  assert.equal(isKickoff("generate a wiki plan", "idle"), true);
  assert.equal(isKickoff("generate", "done"), true);
  assert.equal(isKickoff("hello there", "idle"), false);
  assert.equal(isKickoff("", "idle"), false);
  assert.equal(isKickoff("generate a wiki plan", "awaiting_plan"), false);
  assert.equal(isKickoff("generate", "awaiting_publish"), false);
  assert.equal(isKickoff("generate", "planning"), false);
  // undefined phase treated like idle (fresh session)
  assert.equal(isKickoff("generate", undefined), true);
  assert.equal(isKickoff("please run", "idle"), true);
});

test("isKickoffPhrase is phase-agnostic", () => {
  assert.equal(isKickoffPhrase("generate"), true);
  assert.equal(isKickoffPhrase("hello"), false);
  assert.equal(isKickoffPhrase(""), false);
  assert.equal(isKickoffPhrase("/generate"), true);
  assert.equal(isKickoffPhrase("/run"), true);
});

test("normalizeSessionUserText expands slash commands", () => {
  assert.equal(normalizeSessionUserText("/generate"), "generate a wiki plan");
  assert.equal(normalizeSessionUserText("/approve"), "approve");
  assert.equal(normalizeSessionUserText("/deny"), "deny");
  assert.equal(normalizeSessionUserText("/reject"), "deny");
  assert.equal(normalizeSessionUserText("hello"), "hello");
});

test("resolveSessionTurnMode: resume when resumeData + existingRunId", () => {
  const r = resolveSessionTurnMode({
    userText: "approve",
    phase: "awaiting_plan",
    status: "waiting",
    hasSources: true,
    resumeData: { action: "approve" },
    existingRunId: "run-1",
  });
  assert.deepEqual(r, { mode: "resume" });
});

test("resolveSessionTurnMode: start on kickoff idle/done with sources", () => {
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
      userText: "generate a wiki plan",
      phase: "done",
      status: "completed",
      hasSources: true,
    }),
    { mode: "start" },
  );
  // undefined phase ≈ idle
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "generate",
      phase: undefined,
      status: "active",
      hasSources: true,
    }),
    { mode: "start" },
  );
});

test("resolveSessionTurnMode: free-text never auto-starts", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "hello there",
      phase: "idle",
      status: "active",
      hasSources: true,
    }),
    { mode: "help", helpReason: "not_kickoff" },
  );
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "",
      phase: "idle",
      status: "active",
      hasSources: true,
    }),
    { mode: "help", helpReason: "not_kickoff" },
  );
});

test("resolveSessionTurnMode: no sources on kickoff or free-text", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "generate",
      phase: "idle",
      status: "active",
      hasSources: false,
    }),
    { mode: "help", helpReason: "no_sources" },
  );
  // Free-text without sources must not suggest "say generate" first.
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "hello",
      phase: "idle",
      status: "active",
      hasSources: false,
    }),
    { mode: "help", helpReason: "no_sources" },
  );
});

test("resolveSessionTurnMode: mid-flight phases block start", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "generate",
      phase: "planning",
      status: "active",
      hasSources: true,
    }),
    { mode: "help", helpReason: "running" },
  );
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "generate",
      phase: "writing",
      status: "active",
      hasSources: true,
    }),
    { mode: "help", helpReason: "running" },
  );
});

test("resolveSessionTurnMode: pending gate without resume", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "hello",
      phase: "awaiting_plan",
      status: "waiting",
      hasSources: true,
    }),
    { mode: "help", helpReason: "pending_gate" },
  );
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "generate",
      phase: "awaiting_publish",
      status: "waiting",
      hasSources: true,
    }),
    { mode: "help", helpReason: "pending_gate" },
  );
  // resumeData alone without run id is not resume
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "approve",
      phase: "awaiting_plan",
      status: "waiting",
      hasSources: true,
      resumeData: { action: "approve" },
    }),
    { mode: "help", helpReason: "pending_gate" },
  );
});

test("resolveSessionTurnMode: running blocks start", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "generate",
      phase: "idle",
      status: "running",
      hasSources: true,
    }),
    { mode: "help", helpReason: "running" },
  );
});

test("resolveSessionTurnMode: resume still wins while status running at gate", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "approve",
      phase: "awaiting_plan",
      status: "running",
      hasSources: true,
      resumeData: { action: "approve" },
      existingRunId: "run-1",
    }),
    { mode: "resume" },
  );
});

test("resolveSessionTurnMode: stale approve after eager gate-exit is running help", () => {
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "approve",
      phase: "writing",
      status: "running",
      hasSources: true,
      resumeData: { action: "approve" },
      existingRunId: "run-1",
    }),
    { mode: "help", helpReason: "running" },
  );
  assert.deepEqual(
    resolveSessionTurnMode({
      userText: "approve",
      phase: "planning",
      status: "running",
      hasSources: true,
      resumeData: { action: "approve" },
      existingRunId: "run-1",
    }),
    { mode: "help", helpReason: "running" },
  );
});

test("helpTextForSessionTurn is contextual", () => {
  assert.match(
    helpTextForSessionTurn({ helpReason: "no_sources" }),
    /Sources/,
  );
  assert.match(
    helpTextForSessionTurn({ helpReason: "running" }),
    /Stop/,
  );
  assert.match(
    helpTextForSessionTurn({
      helpReason: "pending_gate",
      phase: "awaiting_plan",
      userText: "hello",
    }),
    /request changes|free-text revision/i,
  );
  assert.match(
    helpTextForSessionTurn({
      helpReason: "pending_gate",
      phase: "awaiting_plan",
      userText: "revise",
    }),
    /modification feedback/i,
  );
  // Kickoff-like at gate: do not pretend generate will start
  const gateKickoff = helpTextForSessionTurn({
    helpReason: "pending_gate",
    phase: "awaiting_plan",
    userText: "generate",
  });
  assert.match(gateKickoff, /pending/i);
  assert.match(gateKickoff, /before starting/i);
  assert.match(
    helpTextForSessionTurn({
      helpReason: "pending_gate",
      phase: "awaiting_publish",
      userText: "generate",
    }),
    /publication/i,
  );
  assert.match(
    helpTextForSessionTurn({ helpReason: "not_kickoff" }),
    /generate/,
  );
  assert.match(
    helpTextForSessionTurn({ helpReason: "not_kickoff" }),
    /\/generate/,
  );
});

test("uiMessagesToSessionMessages preserves tool and data parts", () => {
  const messages: UIMessage[] = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "generate" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "plan" },
        {
          type: "tool-request_user_decision",
          toolCallId: "t1",
          state: "input-available",
          input: { question: "ok?", mode: "choice_only", options: [] },
        } as UIMessage["parts"][number],
        {
          type: "data-run",
          id: "d1",
          data: { runId: "run-123", status: "starting" },
        } as UIMessage["parts"][number],
        {
          type: "data-choice",
          id: "d2",
          data: { question: "Pick", mode: "choice_only", options: [] },
        } as UIMessage["parts"][number],
        {
          type: "data-plan",
          id: "d3",
          data: {
            summary: "s",
            pages: [{ path: "overview.md", purpose: "overview" }],
          },
        } as UIMessage["parts"][number],
      ],
    },
  ];

  const stored = uiMessagesToSessionMessages(messages);
  assert.equal(stored.length, 2);
  assert.equal(stored[1]!.parts.length, 5);
  assert.equal(stored[1]!.parts[2]!.type, "data-run");
  assert.deepEqual((stored[1]!.parts[2] as { data: unknown }).data, {
    runId: "run-123",
    status: "starting",
  });
  assert.equal(stored[1]!.parts[4]!.type, "data-plan");

  const roundTrip = sessionMessagesToUIMessages(stored);
  assert.equal(roundTrip[1]!.parts.length, 5);
  const dataRun = roundTrip[1]!.parts.find((p) => p.type === "data-run");
  assert.ok(dataRun);
  assert.equal(
    (dataRun as { data: { runId: string } }).data.runId,
    "run-123",
  );
  const dataPlan = roundTrip[1]!.parts.find((p) => p.type === "data-plan");
  assert.ok(dataPlan);
  assert.equal(
    (dataPlan as { data: { pages: unknown[] } }).data.pages.length,
    1,
  );
});

test("uiMessagesToSessionMessages fills empty parts", () => {
  const stored = uiMessagesToSessionMessages([
    { id: "u1", role: "user", parts: [] },
  ]);
  assert.equal(stored[0]!.parts.length, 1);
  assert.equal(stored[0]!.parts[0]!.type, "text");
});

test("sessionMessagesToUIMessages round-trips step-start", () => {
  const stored = uiMessagesToSessionMessages([
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "step-start" } as UIMessage["parts"][number],
        { type: "text", text: "hi" },
      ],
    },
  ]);
  assert.equal(stored[0]!.parts[0]!.type, "step-start");
  const ui = sessionMessagesToUIMessages(stored);
  assert.equal(ui[0]!.parts[0]!.type, "step-start");
  assert.equal(ui[0]!.parts[1]!.type, "text");
});
