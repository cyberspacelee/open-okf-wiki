import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLateAbortStatus,
  canTransitionToCancelled,
  cancelWinsOverPatch,
  isCancellableRunStatus,
  isDurableRunStatus,
} from "./run-status-policy.js";

test("isDurableRunStatus", () => {
  assert.equal(isDurableRunStatus("published"), true);
  assert.equal(isDurableRunStatus("publication_declined"), true);
  assert.equal(isDurableRunStatus("cancelled"), false);
  assert.equal(isDurableRunStatus(undefined), false);
});

test("isCancellableRunStatus", () => {
  assert.equal(isCancellableRunStatus("running"), true);
  assert.equal(isCancellableRunStatus("awaiting_plan"), true);
  assert.equal(isCancellableRunStatus("awaiting_publication"), true);
  assert.equal(isCancellableRunStatus("cancelled"), true);
  assert.equal(isCancellableRunStatus("published"), false);
  assert.equal(isCancellableRunStatus("failed"), false);
});

test("cancelWinsOverPatch", () => {
  assert.equal(cancelWinsOverPatch("cancelled", "published"), true);
  assert.equal(cancelWinsOverPatch("cancelled", "cancelled"), false);
  assert.equal(cancelWinsOverPatch("running", "published"), false);
  assert.equal(cancelWinsOverPatch("cancelled", undefined), false);
});

test("canTransitionToCancelled", () => {
  assert.equal(canTransitionToCancelled("running"), true);
  assert.equal(canTransitionToCancelled("published"), false);
});

test("applyLateAbortStatus preserves durable", () => {
  const published = { status: "published" as const, pages: ["a.md"] };
  assert.equal(
    applyLateAbortStatus(published, true),
    published,
  );
  const running = {
    status: "awaiting_plan" as const,
    plan: {
      version: 1 as const,
      summary: "x",
      audience: "a",
      domains: [],
      pages: [
        {
          path: "a",
          purpose: "b",
          domainIds: [],
          questions: [],
          critical: true,
        },
      ],
      openQuestions: [],
      acceptance: {
        reviewRequired: true,
        maxRepairRounds: 2,
        blockingSeverities: ["blocking" as const],
      },
      changelog: [],
    },
  };
  const cancelled = applyLateAbortStatus(running, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(applyLateAbortStatus(running, false), running);
});
