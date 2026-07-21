import assert from "node:assert/strict";
import test from "node:test";
import type { WikiRunPlan } from "@okf-wiki/contract";
import {
  sessionProjectionForRunStatus,
  sessionViewFromRunStatus,
  transition,
  type SessionRunEvent,
  type SessionRunState,
} from "./session-run-transition.js";

const samplePlan: WikiRunPlan = {
  summary: "plan",
  pages: [{ path: "a.md", purpose: "p" }],
};

const idle: SessionRunState = {
  sessionStatus: "active",
  workflowPhase: "idle",
};

function project(status: string) {
  return sessionProjectionForRunStatus(status);
}

test("sessionProjectionForRunStatus table", () => {
  const rows: Array<[string, string, string]> = [
    ["awaiting_plan", "waiting", "awaiting_plan"],
    ["awaiting_publication", "waiting", "awaiting_publish"],
    ["running", "running", "writing"],
    ["published", "completed", "done"],
    ["publication_declined", "active", "done"],
    ["failed", "failed", "idle"],
    ["cancelled", "active", "idle"],
    ["needs_input", "active", "idle"],
  ];
  for (const [status, sessionStatus, workflowPhase] of rows) {
    const p = project(status);
    assert.equal(p.sessionStatus, sessionStatus, status);
    assert.equal(p.workflowPhase, workflowPhase, status);
  }
});

test("TurnStarted → running/planning + linkedRunId", () => {
  const patches = transition(
    { type: "TurnStarted", runId: "r1" },
    idle,
  );
  assert.equal(patches.session?.status, "running");
  assert.equal(patches.session?.workflow?.phase, "planning");
  assert.equal(patches.session?.workflow?.linkedRunId, "r1");
  assert.equal(patches.session?.pending, null);
  assert.equal(patches.run?.status, "running");
  assert.equal(patches.ignore, undefined);
});

test("TurnStarted neutralizes when leaving a gate", () => {
  const patches = transition(
    { type: "TurnStarted", runId: "r1" },
    {
      sessionStatus: "waiting",
      workflowPhase: "awaiting_plan",
      pending: {
        type: "approval",
        question: "?",
        mode: "choice_only",
        selectionMode: "single",
        options: [],
      },
    },
  );
  assert.equal(patches.neutralizeDecisions, true);
});

test("WorkflowLive defaults to writing; preserves planning", () => {
  const live = transition({ type: "WorkflowLive", runId: "r1" }, idle);
  assert.equal(live.session?.status, "running");
  assert.equal(live.session?.workflow?.phase, "writing");
  assert.equal(live.run?.status, "running");

  const fromPlan = transition(
    { type: "WorkflowLive", runId: "r1" },
    { sessionStatus: "running", workflowPhase: "planning", linkedRunId: "r1" },
  );
  assert.equal(fromPlan.session?.workflow?.phase, "planning");

  const forced = transition(
    { type: "WorkflowLive", runId: "r1", phase: "writing" },
    { sessionStatus: "running", workflowPhase: "planning" },
  );
  assert.equal(forced.session?.workflow?.phase, "writing");
});

test("WorkflowSuspended plan / publication", () => {
  const planGate = transition(
    {
      type: "WorkflowSuspended",
      runId: "r1",
      gate: "plan",
      plan: samplePlan,
    },
    idle,
  );
  assert.equal(planGate.session?.status, "waiting");
  assert.equal(planGate.session?.workflow?.phase, "awaiting_plan");
  assert.equal(planGate.session?.workflow?.plan, samplePlan);
  assert.equal(planGate.run?.status, "awaiting_plan");
  assert.equal(planGate.appendHint?.runStatus, "awaiting_plan");
  assert.match(planGate.appendHint?.text ?? "", /plan/i);

  const pub = transition(
    {
      type: "WorkflowSuspended",
      gate: "publication",
      pages: ["a.md"],
      summary: "Review publish",
    },
    { ...idle, linkedRunId: "r2" },
  );
  assert.equal(pub.session?.status, "waiting");
  assert.equal(pub.session?.workflow?.phase, "awaiting_publish");
  assert.equal(pub.run?.status, "awaiting_publication");
  assert.deepEqual(pub.run?.pages, ["a.md"]);
  assert.equal(pub.appendHint?.text, "Review publish");
  assert.equal(pub.appendHint?.runId, "r2");
});

test("WorkflowTerminal published / failed / declined", () => {
  const published = transition(
    {
      type: "WorkflowTerminal",
      runId: "r1",
      status: "published",
      pages: ["x.md"],
      summary: "ok",
    },
    { sessionStatus: "running", workflowPhase: "writing", linkedRunId: "r1" },
  );
  assert.equal(published.session?.status, "completed");
  assert.equal(published.session?.workflow?.phase, "done");
  assert.equal(published.session?.pending, null);
  assert.equal(published.run?.status, "published");
  assert.equal(published.neutralizeDecisions, true);
  assert.equal(published.appendHint?.text, "ok");

  const failed = transition(
    {
      type: "WorkflowTerminal",
      status: "failed",
      error: "plan-gate: boom",
    },
    idle,
  );
  assert.equal(failed.session?.status, "failed");
  assert.equal(failed.session?.workflow?.phase, "idle");
  assert.match(failed.run?.summary ?? "", /Wiki Run failed: plan-gate/);

  const declined = transition(
    {
      type: "WorkflowTerminal",
      status: "publication_declined",
      pages: ["a.md"],
    },
    { sessionStatus: "waiting", workflowPhase: "awaiting_publish" },
  );
  assert.equal(declined.session?.status, "active");
  assert.equal(declined.session?.workflow?.phase, "done");
  assert.equal(declined.run?.status, "publication_declined");
});

test("WorkflowTerminal cancel-wins: ignore non-cancel after cancelled", () => {
  const patches = transition(
    {
      type: "WorkflowTerminal",
      status: "published",
      summary: "should not land",
    },
    {
      sessionStatus: "active",
      workflowPhase: "idle",
      runStatus: "cancelled",
      summary: "Wiki Run cancelled",
    },
  );
  assert.equal(patches.ignore, true);
  assert.equal(patches.ignoreReason, "cancel_wins");
  assert.equal(patches.run?.status, "cancelled");
});

test("Cancel allowed / durable / not cancellable", () => {
  const ok = transition(
    { type: "Cancel", runId: "r1" },
    { sessionStatus: "running", workflowPhase: "writing", runStatus: "running" },
  );
  assert.equal(ok.ignore, undefined);
  assert.equal(ok.run?.status, "cancelled");
  assert.equal(ok.session?.status, "active");
  assert.equal(ok.session?.workflow?.phase, "idle");
  assert.equal(ok.neutralizeDecisions, true);

  const atGate = transition(
    { type: "Cancel" },
    {
      sessionStatus: "waiting",
      workflowPhase: "awaiting_plan",
      runStatus: "awaiting_plan",
    },
  );
  assert.equal(atGate.run?.status, "cancelled");

  const durable = transition(
    { type: "Cancel" },
    {
      sessionStatus: "completed",
      workflowPhase: "done",
      runStatus: "published",
    },
  );
  assert.equal(durable.ignore, true);
  assert.equal(durable.ignoreReason, "durable_outcome");

  const failed = transition(
    { type: "Cancel" },
    {
      sessionStatus: "failed",
      workflowPhase: "idle",
      runStatus: "failed",
    },
  );
  assert.equal(failed.ignore, true);
  assert.equal(failed.ignoreReason, "not_cancellable");

  // Idempotent cancel on already-cancelled.
  const again = transition(
    { type: "Cancel" },
    {
      sessionStatus: "active",
      workflowPhase: "idle",
      runStatus: "cancelled",
    },
  );
  assert.equal(again.ignore, undefined);
  assert.equal(again.run?.status, "cancelled");
});

test("ReconcileOnLoad maps status without inventing pending", () => {
  const gate = transition(
    { type: "ReconcileOnLoad", runStatus: "awaiting_plan", plan: samplePlan },
    {
      sessionStatus: "running",
      workflowPhase: "writing",
      linkedRunId: "r1",
      pending: {
        type: "approval",
        question: "ok?",
        mode: "choice_only",
        selectionMode: "single",
        options: [],
      },
    },
  );
  assert.equal(gate.session?.status, "waiting");
  assert.equal(gate.session?.workflow?.phase, "awaiting_plan");
  assert.ok(gate.session?.pending);
  assert.equal(gate.neutralizeDecisions, false);

  const done = transition(
    { type: "ReconcileOnLoad", runStatus: "published" },
    {
      sessionStatus: "running",
      workflowPhase: "writing",
      linkedRunId: "r1",
    },
  );
  assert.equal(done.session?.status, "completed");
  assert.equal(done.session?.workflow?.phase, "done");
  assert.equal(done.session?.pending, null);
  assert.equal(done.neutralizeDecisions, true);
});

test("sessionViewFromRunStatus mirrors transition (agent adapter)", () => {
  assert.deepEqual(
    sessionViewFromRunStatus({
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

  const declined = sessionViewFromRunStatus({
    status: "publication_declined",
    pages: ["x.md"],
  });
  assert.equal(declined.status, "active");
  assert.equal(declined.workflowPhase, "done");
  assert.equal(declined.runStatus, "publication_declined");

  const planGate = sessionViewFromRunStatus({
    status: "awaiting_plan",
    suspended: true,
    suspendGate: "plan",
    plan: samplePlan,
    summary: "Awaiting plan confirmation",
  });
  assert.equal(planGate.status, "waiting");
  assert.equal(planGate.workflowPhase, "awaiting_plan");
  assert.equal(planGate.runStatus, "awaiting_plan");

  const failed = sessionViewFromRunStatus({
    status: "failed",
    error: "plan-gate: Agent plan phase aborted",
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.summary ?? "", /Wiki Run failed/);
  assert.doesNotMatch(failed.summary ?? "", /\[object Object\]/);
});

test("table-driven WorkflowTerminal for every WikiRunRecordStatus", () => {
  const statuses = [
    "running",
    "published",
    "needs_input",
    "failed",
    "cancelled",
    "awaiting_plan",
    "awaiting_publication",
    "publication_declined",
  ] as const;

  for (const status of statuses) {
    const event: SessionRunEvent = {
      type: "WorkflowTerminal",
      status,
      summary: `s-${status}`,
    };
    const patches = transition(event, idle);
    assert.equal(patches.ignore, undefined, status);
    assert.equal(patches.run?.status, status);
    const proj = sessionProjectionForRunStatus(status);
    assert.equal(patches.session?.status, proj.sessionStatus, status);
    assert.equal(patches.session?.workflow?.phase, proj.workflowPhase, status);
  }
});
