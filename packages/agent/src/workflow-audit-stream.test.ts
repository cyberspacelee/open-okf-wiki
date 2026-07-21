/**
 * Pilot: workflowSnapshotToStream produces framework UI parts for a snapshot.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  minimalWorkflowStateForAudit,
  openWikiRunAuditStream,
} from "./workflow-audit-stream.js";

test("openWikiRunAuditStream emits start + data-workflow* + finish", async () => {
  const state = minimalWorkflowStateForAudit({
    runId: "audit-run-1",
    status: "success",
  });
  const stream = openWikiRunAuditStream(state);
  const reader = stream.getReader();
  const types: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const part = value as { type?: string };
      if (typeof part?.type === "string") {
        types.push(part.type);
      }
    }
  } finally {
    reader.releaseLock();
  }
  assert.ok(types.includes("start"), `types=${types.join(",")}`);
  assert.ok(types.includes("finish"), `types=${types.join(",")}`);
  // Framework workflow data parts (name may be data-workflow or nested).
  assert.ok(
    types.some((t) => t === "data-workflow" || t.startsWith("data-workflow")),
    `expected data-workflow* in ${types.join(",")}`,
  );
});
