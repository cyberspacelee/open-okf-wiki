/**
 * Run audit via framework `workflowSnapshotToStream` (ADR 0027 Phase 6).
 *
 * Live job timeline uses openWikiRunUiProjection (toAISdkStream).
 * Terminal / empty-buffer SSE replay uses this module + getWorkflowRunById.
 */

import { workflowSnapshotToStream } from "@mastra/ai-sdk";
import type { WorkflowState } from "@mastra/core/workflows";
import { getMastra } from "./mastra-instance.js";
import { WIKI_RUN_WORKFLOW_ID } from "./wiki-workflow.js";

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
 * Load the Mastra workflow snapshot for a product run id, if storage has it.
 */
export async function loadWikiRunWorkflowSnapshot(
  runId: string,
): Promise<WorkflowState | null> {
  try {
    const mastra = getMastra();
    const workflow = mastra.getWorkflow(WIKI_RUN_WORKFLOW_ID);
    const state = await workflow.getWorkflowRunById(runId);
    return (state as WorkflowState | null | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Minimal fixture-shaped WorkflowState for unit tests / smoke.
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
