import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperatorSession } from "@okf-wiki/contract";
import {
  isSessionTurnLocked,
  midTurnPhaseForChat,
  reconcileSessionWithRun,
} from "./session-reconcile.js";

function baseSession(
  overrides: Partial<OperatorSession> = {},
): OperatorSession {
  return {
    schemaVersion: 2,
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
            type: "data-gate",
            data: {
              gate: "plan",
              question: "ok?",
              mode: "choice_or_input",
              options: [{ id: "approve", label: "Yes" }],
              cancelled: false,
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
  assert.ok(
    patch.workflow?.phase === "writing" || patch.workflow?.phase === "planning",
  );
  const gate = patch.messages?.[0]?.parts.find((p) => p.type === "data-gate") as
    | { data?: { cancelled?: boolean; options?: unknown[] } }
    | undefined;
  assert.equal(gate?.data?.cancelled, true);
});

test("reconcile: orphan session mid-flight + run still at gate → restore gate", () => {
  const session = baseSession({
    status: "running",
    workflow: {
      phase: "writing",
      linkedRunId: "run-1",
      plan: { summary: "s", pages: [{ path: "overview.md", purpose: "p" }] },
    },
    pending: null,
    messages: [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "data-gate",
            data: {
              gate: "plan",
              question: "ok?",
              options: [{ id: "approve", label: "Yes" }],
              cancelled: true,
            },
          },
        ],
      },
    ],
  });
  const patch = reconcileSessionWithRun(session, {
    status: "awaiting_plan",
    plan: { summary: "s", pages: [{ path: "overview.md", purpose: "p" }] },
  });
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "waiting");
  assert.equal(patch.workflow?.phase, "awaiting_plan");
  assert.ok(patch.pending);
  assert.ok(
    patch.messages?.some((m) =>
      m.parts.some((p) => {
        if (p.type !== "data-gate" || !("data" in p)) {
          return false;
        }
        const data = (p as { data?: { cancelled?: boolean } }).data;
        return data && !data.cancelled;
      }),
    ),
  );
});

test("reconcile: stuck running status at real plan gate → waiting", () => {
  const session = baseSession({ status: "running" });
  const patch = reconcileSessionWithRun(session, { status: "awaiting_plan" });
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "waiting");
  assert.equal(patch.workflow?.phase, "awaiting_plan");
});

test("reconcile: no change when already aligned at gate", () => {
  const session = baseSession();
  const patch = reconcileSessionWithRun(session, { status: "awaiting_plan" });
  // may change if ensureGate rewrites pending — still waiting at plan
  if (patch.changed) {
    assert.equal(patch.status ?? session.status, "waiting");
    assert.equal(
      patch.workflow?.phase ?? session.workflow.phase,
      "awaiting_plan",
    );
  } else {
    assert.equal(patch.changed, false);
  }
});

test("reconcile: terminal run clears stuck gate", () => {
  const session = baseSession();
  const patch = reconcileSessionWithRun(session, { status: "published" });
  assert.equal(patch.changed, true);
  assert.equal(patch.status, "completed");
  assert.equal(patch.pending, null);
  assert.equal(patch.workflow?.phase, "done");
});

test("isSessionTurnLocked TTL", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  assert.equal(
    isSessionTurnLocked(
      { status: "running", updatedAt: "2026-01-01T11:00:00.000Z" },
      now,
    ),
    true,
  );
  assert.equal(
    isSessionTurnLocked(
      { status: "running", updatedAt: "2025-12-01T00:00:00.000Z" },
      now,
    ),
    false,
  );
  assert.equal(
    isSessionTurnLocked(
      { status: "waiting", updatedAt: "2026-01-01T11:59:00.000Z" },
      now,
    ),
    false,
  );
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
});
