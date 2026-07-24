import assert from "node:assert/strict";
import test from "node:test";
import { StoredRunRecordSchema } from "./run.js";

test("Wiki Run Record ignores pre-v2 records instead of accepting legacy shape", () => {
  const legacy = {
    runId: "run-1",
    workspaceId: "workspace-1",
    status: "running",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };

  assert.equal(StoredRunRecordSchema.safeParse(legacy).success, false);
});

test("Wiki Run Record v2 requires every frozen input and outcome field", () => {
  const complete = {
    schema: "okf.wiki-run/v2",
    runId: "run-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    status: "running",
    autoApprove: false,
    error: null,
    skillPath: "/workspace/.okf-wiki/runs/run-1/skill",
    skillDigest: "a".repeat(64),
    sources: [
      {
        id: "main",
        revision: "b".repeat(40),
        effectiveIgnores: ["node_modules/**", "private/**"],
      },
    ],
    spec: null,
    pages: [],
    summary: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  } as const;

  assert.deepEqual(StoredRunRecordSchema.parse(complete), complete);
  for (const field of Object.keys(complete)) {
    const missing = { ...complete } as Record<string, unknown>;
    delete missing[field];
    assert.equal(
      StoredRunRecordSchema.safeParse(missing).success,
      false,
      `expected missing ${field} to be rejected`,
    );
  }
});
