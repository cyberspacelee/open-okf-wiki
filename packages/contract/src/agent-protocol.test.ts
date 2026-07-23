import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProductInject,
  isProductInjectKind,
  parseAgentCommand,
  PRODUCT_INJECT_KINDS,
  ProductSseEventSchema,
  ProductWorkUnitEventSchema,
  safeParseAgentCommand,
} from "./agent-protocol.js";
import { defaultWikiRunSpec } from "./run.js";

const samplePlan = {
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

test("parseAgentCommand: start_wiki_run", () => {
  const cmd = parseAgentCommand({
    type: "start_wiki_run",
    notes: "generate",
    autoApprove: false,
  });
  assert.equal(cmd.type, "start_wiki_run");
  if (cmd.type === "start_wiki_run") {
    assert.equal(cmd.notes, "generate");
    assert.equal(cmd.autoApprove, false);
  }
});

test("parseAgentCommand: resume_gate approve plan", () => {
  const cmd = parseAgentCommand({
    type: "resume_gate",
    gate: "plan",
    action: "approve",
    plan: samplePlan,
    runId: "run-1",
  });
  assert.equal(cmd.type, "resume_gate");
  if (cmd.type === "resume_gate") {
    assert.equal(cmd.gate, "plan");
    assert.equal(cmd.action, "approve");
    assert.equal(cmd.runId, "run-1");
    assert.equal(cmd.plan?.pages.length, 1);
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

test("ProductSseEventSchema: run_phase | gate | run_link", () => {
  const phase = ProductSseEventSchema.parse({
    source: "product",
    kind: "run_phase",
    sessionId: "s1",
    runId: "r1",
    phase: "planning",
    message: "planning…",
  });
  assert.equal(phase.kind, "run_phase");

  const gate = ProductSseEventSchema.parse({
    source: "product",
    kind: "gate",
    sessionId: "s1",
    gate: "plan",
    plan: samplePlan,
    question: "Approve plan?",
  });
  assert.equal(gate.kind, "gate");

  const link = ProductSseEventSchema.parse({
    source: "product",
    kind: "run_link",
    sessionId: "s1",
    runId: "r1",
    status: "running",
  });
  assert.equal(link.kind, "run_link");
});

test("ProductSseEventSchema: work_unit accepted; agent_span rejected", () => {
  const unit = ProductWorkUnitEventSchema.parse({
    source: "product",
    kind: "work_unit",
    sessionId: "s1",
    runId: "r1",
    unitId: "leaf-1",
    role: "leaf",
    status: "running",
    task: "Explore domain",
    message: { text: "reading sources…" },
    tools: [
      {
        toolCallId: "t1",
        toolName: "read",
        state: "output-available",
        input: { path: "src/a.ts" },
      },
    ],
  });
  assert.equal(unit.kind, "work_unit");
  assert.equal(unit.unitId, "leaf-1");

  const viaUnion = ProductSseEventSchema.parse(unit);
  assert.equal(viaUnion.kind, "work_unit");

  const legacySpan = ProductSseEventSchema.safeParse({
    source: "product",
    kind: "agent_span",
    sessionId: "s1",
    spanId: "x",
    agentId: "leaf-1",
    role: "leaf",
    status: "running",
  });
  assert.equal(legacySpan.success, false);
});

test("assertProductInject: whitelist only", () => {
  for (const kind of PRODUCT_INJECT_KINDS) {
    assert.equal(isProductInjectKind(kind), true);
    assertProductInject(kind);
  }
  assert.equal(isProductInjectKind("agent_span"), false);
  assert.equal(isProductInjectKind("child_pi"), false);
  assert.throws(() => assertProductInject("agent_span"), /whitelist/);
  assert.throws(() => assertProductInject("child_pi"), /whitelist/);
});
