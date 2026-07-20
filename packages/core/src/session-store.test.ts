import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendSessionMessages,
  createOperatorSession,
  deleteOperatorSession,
  loadOperatorSession,
  listOperatorSessions,
  resetOperatorSessionWorkflow,
} from "./session-store.js";

test("create/load/list operator sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-sess-"));
  const s = await createOperatorSession({
    workspaceRoot: root,
    workspaceId: "ws1",
    title: "T",
  });
  assert.equal(s.workspaceId, "ws1");
  const loaded = await loadOperatorSession(root, s.id);
  assert.equal(loaded?.id, s.id);
  const list = await listOperatorSessions(root);
  assert.equal(list.length, 1);
});

test("appendSessionMessages updates pending and workflow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-sess-a-"));
  const s = await createOperatorSession({
    workspaceRoot: root,
    workspaceId: "ws1",
  });
  const next = await appendSessionMessages(
    root,
    s.id,
    [
      {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
      },
    ],
    {
      status: "waiting",
      pending: {
        type: "choice",
        question: "Pick",
        mode: "choice_only",
        selectionMode: "single",
        options: [{ id: "a", label: "A" }],
      },
      workflow: { phase: "awaiting_plan" },
    },
  );
  assert.equal(next.messages.length, 1);
  assert.equal(next.status, "waiting");
  assert.equal(next.pending?.mode, "choice_only");
});

test("resetOperatorSessionWorkflow clears gate and neutralizes chips", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-sess-r-"));
  const s = await createOperatorSession({
    workspaceRoot: root,
    workspaceId: "ws1",
  });
  await appendSessionMessages(
    root,
    s.id,
    [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "plan?" },
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
          {
            type: "data-choice",
            data: {
              question: "ok?",
              options: [{ id: "approve", label: "Yes" }],
            },
          },
        ],
      },
    ],
    {
      status: "waiting",
      pending: {
        type: "choice",
        question: "ok?",
        mode: "choice_only",
        selectionMode: "single",
        options: [{ id: "approve", label: "Yes" }],
      },
      workflow: { phase: "awaiting_plan", linkedRunId: "run-1" },
    },
  );
  const reset = await resetOperatorSessionWorkflow(root, s.id);
  assert.equal(reset.status, "active");
  assert.equal(reset.pending, null);
  assert.equal(reset.workflow.phase, "idle");
  assert.equal(reset.workflow.linkedRunId, "run-1");
  const tool = reset.messages[0]!.parts.find(
    (p) => p.type === "tool-request_user_decision",
  ) as { state?: string } | undefined;
  assert.equal(tool?.state, "output-available");
  const choice = reset.messages[0]!.parts.find((p) => p.type === "data-choice") as
    | { data?: { cancelled?: boolean; options?: unknown[] } }
    | undefined;
  assert.equal(choice?.data?.cancelled, true);
  assert.deepEqual(choice?.data?.options, []);
});

test("deleteOperatorSession removes file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-sess-d-"));
  const s = await createOperatorSession({
    workspaceRoot: root,
    workspaceId: "ws1",
  });
  assert.equal(await deleteOperatorSession(root, s.id), true);
  assert.equal(await loadOperatorSession(root, s.id), null);
  assert.equal(await deleteOperatorSession(root, s.id), false);
  assert.equal(await deleteOperatorSession(root, "../escape"), false);
});
