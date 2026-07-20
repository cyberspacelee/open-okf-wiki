import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendSessionMessages,
  createOperatorSession,
  loadOperatorSession,
  listOperatorSessions,
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
