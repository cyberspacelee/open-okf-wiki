import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProductInject,
  isProductInjectKind,
  PRODUCT_INJECT_KINDS,
  ProductSseEventSchema,
  parseAgentCommand,
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

test("ProductSseEventSchema: whitelist run_link | run_phase | gate | plan_progress | defects", () => {
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

  const planProgress = ProductSseEventSchema.parse({
    source: "product",
    kind: "plan_progress",
    sessionId: "s1",
    runId: "r1",
    pages: [{ path: "overview.md", status: "writing" }],
  });
  assert.equal(planProgress.kind, "plan_progress");

  const defects = ProductSseEventSchema.parse({
    source: "product",
    kind: "defects",
    sessionId: "s1",
    runId: "r1",
    round: 1,
    clean: true,
    defectCount: 0,
  });
  assert.equal(defects.kind, "defects");
});

test("ProductSseEventSchema: rejects work_unit, progress, agent_span body channels", () => {
  const workUnit = ProductSseEventSchema.safeParse({
    source: "product",
    kind: "work_unit",
    sessionId: "s1",
    runId: "r1",
    unitId: "leaf-1",
    role: "leaf",
    status: "running",
    task: "Explore domain",
    message: { text: "reading sources…" },
  });
  assert.equal(workUnit.success, false);

  const progress = ProductSseEventSchema.safeParse({
    source: "product",
    kind: "progress",
    sessionId: "s1",
    phase: "writing",
    label: "writing pages",
  });
  assert.equal(progress.success, false);

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
  assert.deepEqual(
    [...PRODUCT_INJECT_KINDS],
    ["run_link", "run_phase", "gate", "plan_progress", "defects"],
  );
  for (const kind of PRODUCT_INJECT_KINDS) {
    assert.equal(isProductInjectKind(kind), true);
    assertProductInject(kind);
  }
  assert.equal(isProductInjectKind("work_unit"), false);
  assert.equal(isProductInjectKind("progress"), false);
  assert.equal(isProductInjectKind("agent_span"), false);
  assert.equal(isProductInjectKind("child_pi"), false);
  assert.throws(() => assertProductInject("work_unit"), /whitelist/);
  assert.throws(() => assertProductInject("progress"), /whitelist/);
  assert.throws(() => assertProductInject("agent_span"), /whitelist/);
  assert.throws(() => assertProductInject("child_pi"), /whitelist/);
});
