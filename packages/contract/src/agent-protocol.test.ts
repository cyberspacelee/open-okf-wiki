import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSseEventSchema, parseAgentCommand, safeParseAgentCommand } from "./agent-protocol.js";
import { defaultWikiRunSpec } from "./run.js";

const sampleSpec = {
  ...defaultWikiRunSpec("S"),
  summary: "S",
  pages: [
    {
      path: "overview.md",
      purpose: "Overview",
      domainIds: ["core"],
      questions: ["Overview?"],
      critical: true,
    },
  ],
};

test("parseAgentCommand: prompt / steer / abort / compact", () => {
  assert.equal(parseAgentCommand({ type: "prompt", text: "hello" }).type, "prompt");
  assert.equal(parseAgentCommand({ type: "steer", text: "stop" }).type, "steer");
  assert.equal(parseAgentCommand({ type: "abort" }).type, "abort");
  assert.equal(parseAgentCommand({ type: "compact" }).type, "compact");
});

test("parseAgentCommand: rejects removed start_wiki_run command", () => {
  assert.equal(safeParseAgentCommand({ type: "start_wiki_run", notes: "generate" }).success, false);
});

test("parseAgentCommand: resume_gate approve Spec", () => {
  const cmd = parseAgentCommand({
    type: "resume_gate",
    gate: "plan",
    action: "approve",
    spec: sampleSpec,
    runId: "run-1",
  });
  assert.equal(cmd.type, "resume_gate");
  if (cmd.type === "resume_gate") {
    assert.equal(cmd.gate, "plan");
    assert.equal(cmd.action, "approve");
    assert.equal(cmd.runId, "run-1");
    assert.equal(cmd.spec?.pages.length, 1);
  }
});

test("parseAgentCommand: resume_gate revise requires feedback", () => {
  const missing = safeParseAgentCommand({
    type: "resume_gate",
    gate: "plan",
    action: "revise",
  });
  assert.equal(missing.success, false);

  const empty = safeParseAgentCommand({
    type: "resume_gate",
    gate: "plan",
    action: "revise",
    feedback: "   ",
  });
  assert.equal(empty.success, false);

  const ok = parseAgentCommand({
    type: "resume_gate",
    gate: "plan",
    action: "revise",
    feedback: "add concepts.md",
  });
  assert.equal(ok.type, "resume_gate");
  if (ok.type === "resume_gate") {
    assert.equal(ok.feedback, "add concepts.md");
  }
});

test("parseAgentCommand: resume_gate revise invalid on publication", () => {
  const bad = safeParseAgentCommand({
    type: "resume_gate",
    gate: "publication",
    action: "revise",
    feedback: "nope",
  });
  assert.equal(bad.success, false);
});

test("parseAgentCommand: resume_gate publication approve/deny", () => {
  assert.equal(
    parseAgentCommand({
      type: "resume_gate",
      gate: "publication",
      action: "approve",
      runId: "r2",
    }).type,
    "resume_gate",
  );
  assert.equal(
    parseAgentCommand({
      type: "resume_gate",
      gate: "publication",
      action: "deny",
    }).type,
    "resume_gate",
  );
});

test("parseAgentCommand: rejects unknown type and empty prompt", () => {
  assert.equal(safeParseAgentCommand({ type: "followUp", text: "x" }).success, false);
  assert.equal(safeParseAgentCommand({ type: "prompt", text: "" }).success, false);
  assert.equal(safeParseAgentCommand({}).success, false);
});

test("AgentSseEventSchema: accepts snapshot, opaque Pi events, and heartbeat only", () => {
  const snapshot = AgentSseEventSchema.parse({
    source: "server",
    kind: "snapshot",
    sessionId: "s1",
    timestamp: "2026-07-24T00:00:00.000Z",
    payload: {
      session: { id: "s1", workspaceId: "w1" },
      messages: [{ role: "user", content: "hello" }],
      activeTool: {
        toolCallId: "tool-1",
        toolName: "wiki_produce",
        details: {
          status: "awaiting_plan",
          runId: "run-1",
          summary: "Awaiting WikiRunSpec approval",
        },
      },
    },
  });
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.source === "server" && snapshot.kind === "snapshot") {
    assert.equal(snapshot.payload.activeTool?.details.status, "awaiting_plan");
  }

  const pi = AgentSseEventSchema.parse({
    source: "pi",
    kind: "message_update",
    sessionId: "s1",
    payload: { event: { type: "text_delta", delta: "hello" } },
  });
  assert.equal(pi.source, "pi");

  const heartbeat = AgentSseEventSchema.parse({
    source: "server",
    kind: "heartbeat",
    sessionId: "s1",
    timestamp: new Date().toISOString(),
  });
  assert.equal(heartbeat.source, "server");

  assert.equal(
    AgentSseEventSchema.safeParse({
      source: "product",
      kind: "run_phase",
      sessionId: "s1",
    }).success,
    false,
  );
});

test("AgentSseEventSchema: rejects sequence/replay framing", () => {
  assert.equal(
    AgentSseEventSchema.safeParse({
      source: "pi",
      kind: "message_update",
      sessionId: "s1",
      sequence: 1,
    }).success,
    false,
  );
});
