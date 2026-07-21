/**
 * Cancel session patch must come from P2 transition(Cancel), not hard-coded
 * status/phase literals (Phase 5 residual from Phase 3).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  transition,
  type SessionRunState,
} from "@okf-wiki/core";

test("Cancel patches match handleCancelRun session cleanup contract", () => {
  const atGate: SessionRunState = {
    sessionStatus: "waiting",
    workflowPhase: "awaiting_plan",
    linkedRunId: "r1",
    runStatus: "awaiting_plan",
    pending: {
      type: "approval",
      question: "Approve plan?",
      mode: "choice_only",
      selectionMode: "single",
      options: [],
    },
  };
  const patches = transition(
    { type: "Cancel", runId: "r1", summary: "Wiki Run cancelled" },
    atGate,
  );
  assert.equal(patches.ignore, undefined);
  assert.equal(patches.session?.status, "active");
  assert.equal(patches.session?.pending, null);
  assert.equal(patches.session?.workflow?.phase, "idle");
  assert.equal(patches.session?.workflow?.linkedRunId, "r1");
  assert.equal(patches.run?.status, "cancelled");
  assert.equal(patches.neutralizeDecisions, true);
});

test("Cancel ignores durable published session", () => {
  const patches = transition(
    { type: "Cancel", runId: "r1" },
    {
      sessionStatus: "completed",
      workflowPhase: "done",
      linkedRunId: "r1",
      runStatus: "published",
    },
  );
  assert.equal(patches.ignore, true);
  assert.equal(patches.ignoreReason, "durable_outcome");
});
