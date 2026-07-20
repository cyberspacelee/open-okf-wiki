import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import {
  isKickoff,
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
