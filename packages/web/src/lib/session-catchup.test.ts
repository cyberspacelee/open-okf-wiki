import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendEphemeralRunLiveLine,
  classifyRunSseForSessionCatchUp,
  isEphemeralRunLiveMessageId,
  isSessionMidFlight,
  mergeSessionCatchUpTimeline,
  stripEphemeralRunLiveMessages,
} from "./session-catchup.ts";

type Msg = { id: string; role: string; parts: { type: string; text?: string }[] };

const midWriting = { status: "running", workflow: { phase: "writing" as const } };
const midPlanning = { status: "running", workflow: { phase: "planning" as const } };
const idle = { status: "waiting", workflow: { phase: "awaiting_plan" as const } };

test("isSessionMidFlight detects running / planning / writing", () => {
  assert.equal(isSessionMidFlight(midWriting), true);
  assert.equal(isSessionMidFlight(midPlanning), true);
  assert.equal(isSessionMidFlight({ status: "running" }), true);
  assert.equal(isSessionMidFlight(idle), false);
  assert.equal(isSessionMidFlight({ status: "active", workflow: { phase: "idle" } }), false);
});

test("stripEphemeralRunLiveMessages drops only run-live rows", () => {
  const msgs: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Starting…" }] },
    {
      id: "run-live-1",
      role: "assistant",
      parts: [{ type: "text", text: "Wiki Run in progress" }],
    },
  ];
  assert.deepEqual(
    stripEphemeralRunLiveMessages(msgs).map((m) => m.id),
    ["u1", "a1"],
  );
  assert.equal(isEphemeralRunLiveMessageId("run-live-99"), true);
  assert.equal(isEphemeralRunLiveMessageId("a1"), false);
});

test("merge: status SSE bubble must not block durable journal catch-up (regression)", () => {
  // Hard refresh → journal has user + streaming assistant.
  const journalBoot: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "generate" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Starting Wiki Run…" }],
    },
  ];
  // Empty-bus reconnect status snapshot was appended as run-live (old bug).
  const afterSse: Msg[] = [
    ...journalBoot,
    {
      id: "run-live-1",
      role: "assistant",
      parts: [{ type: "text", text: "Wiki Run in progress" }],
    },
  ];
  // Later checkpoint: same length as durable, richer assistant parts.
  const journalLater: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "generate" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Starting Wiki Run…\n\nWriting overview.md" },
        { type: "tool-write_wiki" },
      ],
    },
  ];

  const merged = mergeSessionCatchUpTimeline(afterSse, journalLater, midWriting);
  assert.equal(merged.length, 2, "ephemeral bubble must not freeze on length");
  assert.equal(merged[1]!.id, "a1");
  assert.ok(
    merged[1]!.parts.some((p) => p.type === "tool-write_wiki"),
    "tool progress from journal must land",
  );
  assert.ok(
    !merged.some((m) => isEphemeralRunLiveMessageId(m.id)),
    "accepting journal drops ephemeral bubbles",
  );
});

test("merge: empty next keeps prev", () => {
  const prev: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "x" }] },
  ];
  assert.deepEqual(mergeSessionCatchUpTimeline(prev, [], midWriting), prev);
});

test("merge: mid-flight refuses to shrink durable timeline", () => {
  const prev: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "a" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "long" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "b" }] },
  ];
  const short: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "a" }] },
  ];
  assert.deepEqual(
    mergeSessionCatchUpTimeline(prev, short, midWriting).map((m) => m.id),
    ["u1", "a1", "u2"],
  );
  // Idle: prefer durable short (e.g. reset / reconcile).
  assert.deepEqual(
    mergeSessionCatchUpTimeline(prev, short, idle).map((m) => m.id),
    ["u1"],
  );
});

test("merge: mid-flight shrink check ignores ephemeral length only", () => {
  const prev: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "a" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "old" }] },
    {
      id: "run-live-9",
      role: "assistant",
      parts: [{ type: "text", text: "noise" }],
    },
  ];
  // next same durable length, updated text — must accept.
  const next: Msg[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "a" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "new progress" }] },
  ];
  const merged = mergeSessionCatchUpTimeline(prev, next, midPlanning);
  assert.equal(merged[1]!.parts[0]!.text, "new progress");
});

test("classifyRunSseForSessionCatchUp: status/done only tick", () => {
  assert.deepEqual(
    classifyRunSseForSessionCatchUp({
      type: "status",
      status: "running",
      message: "Wiki Run in progress",
    }),
    { action: "tick" },
  );
  assert.deepEqual(
    classifyRunSseForSessionCatchUp({
      type: "done",
      status: "published",
      message: "done",
    }),
    { action: "tick" },
  );
  assert.deepEqual(
    classifyRunSseForSessionCatchUp({
      type: "error",
      status: "failed",
      message: "boom",
    }),
    { action: "tick" },
  );
  assert.deepEqual(
    classifyRunSseForSessionCatchUp({
      status: "awaiting_plan",
      message: "plan ready",
    }),
    { action: "tick" },
  );
});

test("classifyRunSseForSessionCatchUp: progress lines become bubbles", () => {
  assert.deepEqual(
    classifyRunSseForSessionCatchUp({
      type: "log",
      message: "wrote overview.md",
    }),
    { action: "line", line: "wrote overview.md" },
  );
  assert.deepEqual(
    classifyRunSseForSessionCatchUp({
      type: "part",
      text: "tool finished",
    }),
    { action: "line", line: "tool finished" },
  );
  assert.deepEqual(
    classifyRunSseForSessionCatchUp({ type: "log" }),
    { action: "ignore" },
  );
});

test("appendEphemeralRunLiveLine dedupes trailing same line", () => {
  const create = (id: string, line: string): Msg => ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: line }],
  });
  const base: Msg[] = [
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
  ];
  const once = appendEphemeralRunLiveLine(base, "step 1", create, () => 1);
  assert.equal(once.length, 2);
  assert.equal(once[1]!.id, "run-live-1");
  const twice = appendEphemeralRunLiveLine(once, "step 1", create, () => 2);
  assert.equal(twice.length, 2, "duplicate line on last bubble is no-op");
  const next = appendEphemeralRunLiveLine(once, "step 2", create, () => 3);
  assert.equal(next.length, 3);
});
