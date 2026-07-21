/**
 * Phase 5 pilot — Run audit replay via framework `workflowSnapshotToStream`.
 *
 * Prefer this over hand-written Run SSE mapping when a historical Mastra
 * WorkflowState is available (getWorkflowRunById). Live job timeline still
 * uses mapWorkflowStreamEvent; full Run SSE migration is deferred (Phase 6+).
 *
 * Product shell only: no second conversion protocol.
 */

import { workflowSnapshotToStream } from "@mastra/ai-sdk";
import type { WorkflowState } from "@mastra/core/workflows";

/**
 * Convert a persisted Mastra workflow snapshot into AI SDK UI data parts
 * (same shape as live workflow stream transformers).
 */
export function openWikiRunAuditStream(
  workflowRun: WorkflowState,
): ReadableStream {
  return workflowSnapshotToStream(workflowRun);
}

/**
 * Minimal fixture-shaped WorkflowState for unit tests / smoke of the pilot.
 * Not a product API — callers should pass real getWorkflowRunById results.
 */
export function minimalWorkflowStateForAudit(input: {
  runId: string;
  workflowName?: string;
  status?: WorkflowState["status"];
  steps?: WorkflowState["steps"];
}): WorkflowState {
  return {
    runId: input.runId,
    workflowName: input.workflowName ?? "wiki-run",
    status: input.status ?? "success",
    steps: input.steps ?? {
      "plan-gate": {
        status: "success",
        payload: {},
        output: { ok: true },
      },
    },
  } as WorkflowState;
}
