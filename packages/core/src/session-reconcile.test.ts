import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperatorSession } from "@okf-wiki/contract";
import {
  midTurnPhaseForChat,
  reconcileSessionWithRun,
} from "./session-reconcile.js";

function baseSession(
  overrides: Partial<OperatorSession> = {},
): OperatorSession {
  return {
    id: "sess-1",
    workspaceId: "ws-1",
    title: "T",
    status: "waiting",
    messages: [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "plan ready" },
          {
            type: "tool-request_user_decision",
            toolCallId: "t1",
            state: "input-available",
            input: {
              question: "ok?",
              mode: "choice_only",
              options: [{ id: "approve", label: "Yes" }],
            },
          },
        ],
      },
    ],
    workflow: {
      phase: "awaiting_plan",
      linkedRunId: "run-1",
      plan: { summary: "s", pages: [{ path: "overview.md", purpose: "p" }] },
    },
    pending: {
      type: "approval",
      question: "ok?",
      mode: "choice_only",
      selectionMode: "single",
      options: [{ id: "approve", label: "Yes" }],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("reconcile: run writing clears stale plan gate after approve", () => {
  const session = baseSession();
  const patch = reconcileSessionWithRun(session, { status: "running" });
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "running");
  assert.equal(patch.pending, null);
  assert.equal(patch.workflow?.phase, "writing");
  const tool = patch.messages?.[0]?.parts.find(
    (p) => p.type === "tool-request_user_decision",
  ) as { state?: string } | undefined;
  assert.equal(tool?.state, "output-denied");
});

test("reconcile: stuck running status at real plan gate → waiting", () => {
  const session = baseSession({ status: "running" });
  const patch = reconcileSessionWithRun(session, { status: "awaiting_plan" });
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "waiting");
  assert.equal(patch.workflow?.phase, "awaiting_plan");
});

test("reconcile: stuck running at publish gate → waiting", () => {
  const session = baseSession({
    status: "running",
    workflow: {
      phase: "awaiting_publish",
      linkedRunId: "run-1",
    },
    pending: null,
  });
  const patch = reconcileSessionWithRun(session, {
    status: "awaiting_publication",
  });
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "waiting");
  assert.equal(patch.workflow?.phase, "awaiting_publish");
});

test("reconcile: no change when already aligned at gate", () => {
  const session = baseSession();
  const patch = reconcileSessionWithRun(session, { status: "awaiting_plan" });
  assert.equal(patch.changed, false);
});

test("reconcile: terminal run clears stuck gate", () => {
  const session = baseSession();
  const patch = reconcileSessionWithRun(session, { status: "published" });
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "completed");
  assert.equal(patch.pending, null);
  assert.equal(patch.workflow?.phase, "done");
});

test("reconcile: running status + gate phase without run record → waiting", () => {
  const session = baseSession({ status: "running" });
  const patch = reconcileSessionWithRun(session, null);
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "waiting");
});

test("midTurnPhaseForChat", () => {
  assert.equal(midTurnPhaseForChat({ mode: "start" }), "planning");
  assert.equal(
    midTurnPhaseForChat({ mode: "resume", resumeAction: "approve" }),
    "writing",
  );
  assert.equal(
    midTurnPhaseForChat({ mode: "resume", resumeAction: "revise" }),
    "planning",
  );
  assert.equal(
    midTurnPhaseForChat({ mode: "resume", resumeAction: "deny" }),
    "writing",
  );
});
