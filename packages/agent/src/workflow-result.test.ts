/**
 * Table tests for unified Mastra → product terminal mapping.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { WikiRunPlan } from "@okf-wiki/contract";
import {
  collectSuspendPayloads,
  extractSuspendGate,
  isDurableRunStatus,
  mapSuspendedResult,
  mapWorkflowResult,
  sessionViewFromTerminal,
} from "./workflow-result.js";

const samplePlan: WikiRunPlan = {
  summary: "Cover core modules",
  pages: [{ path: "overview.md", purpose: "Intro" }],
};

test("mapWorkflowResult: plan gate from top-level suspendPayload", () => {
  const terminal = mapWorkflowResult({
    status: "suspended",
    suspendPayload: { gate: "plan", plan: samplePlan },
  });
  assert.equal(terminal.status, "awaiting_plan");
  assert.equal(terminal.suspended, true);
  assert.equal(terminal.suspendGate, "plan");
  assert.deepEqual(terminal.plan, samplePlan);
  assert.equal(terminal.summary, "Awaiting plan confirmation");
});

test("mapWorkflowResult: bailed plan deny maps to cancelled", () => {
  const terminal = mapWorkflowResult({
    status: "bailed",
    result: {
      status: "cancelled",
      summary: "Plan declined by operator",
      plan: samplePlan,
    },
  });
  assert.equal(terminal.status, "cancelled");
  assert.match(terminal.summary ?? "", /declined|Plan/i);
  assert.deepEqual(terminal.plan, samplePlan);
});

test("mapWorkflowResult: plan gate from suspended step only", () => {
  const terminal = mapWorkflowResult({
    status: "suspended",
    steps: {
      "plan-gate": {
        status: "suspended",
        suspendPayload: { gate: "plan", plan: samplePlan },
      },
      write: { status: "waiting" },
    },
  });
  assert.equal(terminal.status, "awaiting_plan");
  assert.equal(terminal.suspendGate, "plan");
});

test("mapWorkflowResult: ignores completed step old suspendPayload", () => {
  const terminal = mapWorkflowResult({
    status: "suspended",
    steps: {
      "plan-gate": {
        status: "success",
        suspendPayload: { gate: "plan", plan: samplePlan },
      },
      "publish-gate": {
        status: "suspended",
        suspendPayload: {
          gate: "publication",
          pages: ["overview.md"],
          summary: "Ready",
        },
      },
    },
  });
  assert.equal(terminal.status, "awaiting_publication");
  assert.equal(terminal.suspendGate, "publication");
  assert.deepEqual(terminal.pages, ["overview.md"]);
});

test("mapWorkflowResult: nested suspendPayload by step id", () => {
  const terminal = mapWorkflowResult({
    status: "suspended",
    suspendPayload: {
      "plan-gate": { gate: "plan", plan: samplePlan },
    },
  });
  assert.equal(terminal.status, "awaiting_plan");
  assert.ok(terminal.plan);
});

test("mapWorkflowResult: unknown suspend → needs_input", () => {
  const terminal = mapWorkflowResult({
    status: "suspended",
    suspendPayload: { reason: "mystery" },
  });
  assert.equal(terminal.status, "needs_input");
  assert.equal(terminal.suspended, true);
  assert.equal(terminal.suspendGate, undefined);
});

test("mapWorkflowResult: success published", () => {
  const terminal = mapWorkflowResult({
    status: "success",
    result: {
      status: "published",
      pages: ["a.md"],
      summary: "done",
      publicationPath: "/wiki",
    },
  });
  assert.equal(terminal.status, "published");
  assert.deepEqual(terminal.pages, ["a.md"]);
  assert.equal(terminal.publicationPath, "/wiki");
});

test("mapWorkflowResult: success publication_declined", () => {
  const terminal = mapWorkflowResult({
    status: "success",
    result: {
      status: "publication_declined",
      pages: ["a.md"],
      summary: "kept staging",
    },
  });
  assert.equal(terminal.status, "publication_declined");
});

test("mapWorkflowResult: failed redacts keys", () => {
  const terminal = mapWorkflowResult({
    status: "failed",
    error: new Error("boom sk-proj-abcdefghijklmnopqrstuvwxyz"),
  });
  assert.equal(terminal.status, "failed");
  assert.ok(terminal.error);
  assert.match(terminal.error!, /\[redacted-key\]/);
  assert.doesNotMatch(terminal.error!, /sk-proj-/);
});

test("mapWorkflowResult: failed object error is not [object Object]", () => {
  const terminal = mapWorkflowResult({
    status: "failed",
    error: { message: "model timeout after 120s", code: "ETIMEDOUT" },
  });
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /model timeout/);
  assert.doesNotMatch(terminal.error ?? "", /\[object Object\]/);
});

test("mapWorkflowResult: failed step without top-level error", () => {
  const terminal = mapWorkflowResult({
    status: "failed",
    steps: {
      "plan-gate": {
        name: "plan-gate",
        status: "failed",
        error: { message: "Agent plan phase aborted" },
      },
    },
  });
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /plan-gate/);
  assert.match(terminal.error ?? "", /aborted|Agent plan/);
  assert.doesNotMatch(terminal.error ?? "", /\[object Object\]/);
});

test("sessionViewFromTerminal failed summary is human string", () => {
  const view = sessionViewFromTerminal({
    status: "failed",
    error: "plan-gate: Agent plan phase aborted",
  });
  assert.equal(view.status, "failed");
  assert.match(view.summary ?? "", /Wiki Run failed/);
  assert.doesNotMatch(view.summary ?? "", /\[object Object\]/);
});

test("mapWorkflowResult: success without result → failed", () => {
  const terminal = mapWorkflowResult({ status: "success" });
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /without output/);
});

test("mapSuspendedResult: non-suspended returns null", () => {
  assert.equal(mapSuspendedResult({ status: "success" }), null);
});

test("extractSuspendGate: plan", () => {
  const gate = extractSuspendGate({
    status: "suspended",
    suspendPayload: { gate: "plan", plan: samplePlan },
  });
  assert.equal(gate?.gate, "plan");
  assert.deepEqual(gate?.plan, samplePlan);
});

test("extractSuspendGate: non-suspend null", () => {
  assert.equal(
    extractSuspendGate({
      status: "success",
      result: { status: "published", pages: [] },
    }),
    null,
  );
});

test("sessionViewFromTerminal: published / declined / plan gate", () => {
  assert.deepEqual(
    sessionViewFromTerminal({
      status: "published",
      pages: ["x.md"],
      summary: "ok",
    }),
    {
      status: "completed",
      workflowPhase: "done",
      pages: ["x.md"],
      plan: undefined,
      summary: "ok",
      runStatus: "published",
    },
  );

  const declined = sessionViewFromTerminal({
    status: "publication_declined",
    pages: ["x.md"],
  });
  assert.equal(declined.status, "active");
  assert.equal(declined.workflowPhase, "idle");
  assert.equal(declined.runStatus, "publication_declined");

  const planGate = sessionViewFromTerminal({
    status: "awaiting_plan",
    suspended: true,
    suspendGate: "plan",
    plan: samplePlan,
    summary: "Awaiting plan confirmation",
  });
  assert.equal(planGate.status, "waiting");
  assert.equal(planGate.workflowPhase, "awaiting_plan");
  assert.equal(planGate.runStatus, "awaiting_plan");
});

test("isDurableRunStatus", () => {
  assert.equal(isDurableRunStatus("published"), true);
  assert.equal(isDurableRunStatus("publication_declined"), true);
  assert.equal(isDurableRunStatus("cancelled"), false);
  assert.equal(isDurableRunStatus(undefined), false);
});

test("collectSuspendPayloads dedupes", () => {
  const list = collectSuspendPayloads({
    status: "suspended",
    suspendPayload: { gate: "plan", plan: samplePlan },
    steps: {
      "plan-gate": {
        status: "suspended",
        suspendPayload: { gate: "plan", plan: samplePlan },
      },
    },
  });
  assert.equal(list.length, 1);
});
