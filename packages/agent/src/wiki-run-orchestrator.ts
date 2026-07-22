/**
 * Product open path for the single wiki-run workflow (ADR 0025 / 0027).
 * Owns: createRun, product abort bind/unbind, stream / resumeStream with
 * closeOnSuspend. Stream conversion (toAISdkStream) is NOT owned here —
 * Session and Run console both use openWikiRunUiProjection (workflow-ui-stream)
 * then map to UI chunks or job events.
 */

import type { WikiRunPlan, WorkspaceConfig } from "@okf-wiki/contract";
import { getMastra } from "./mastra-instance.js";
import {
  bindRunAbortSignal,
  unbindRunAbortSignal,
} from "./run-abort.js";
import { WIKI_RUN_WORKFLOW_ID } from "./wiki-workflow.js";

export type WikiRunStartParams = {
  kind: "start";
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  skipPlanConfirm?: boolean;
  forcePlanConfirm?: boolean;
  plan?: WikiRunPlan;
  abortSignal?: AbortSignal;
};

export type WikiRunResumeParams = {
  kind: "resume";
  runId: string;
  /** Mastra step id, e.g. plan-gate | publish-gate */
  step: string;
  resumeData: {
    action: "approve" | "deny" | "revise";
    plan?: WikiRunPlan;
    feedback?: string;
  };
  abortSignal?: AbortSignal;
};

/** Single open-params type for Session UI and Run console projections. */
export type WikiRunOpenParams = WikiRunStartParams | WikiRunResumeParams;

/** Raw Mastra workflow stream handle used by UI projection. */
export type WikiRunWorkflowHandle = {
  runId: string;
  /** Mastra stream output (framework stream + result). */
  output: {
    fullStream?: AsyncIterable<unknown>;
    result: Promise<unknown>;
  };
  /** Unbind product abort after result settles (or on open failure). */
  release: () => void;
};

/**
 * Open wiki-run workflow stream/resumeStream with product abort bound for steps.
 * Explicit closeOnSuspend: true so suspend ends the stream for Session finalize
 * (Mastra default is also true; pass explicitly for ADR 0027 contract).
 * Callers must await output.result (via result()) so release() runs.
 */
export async function openWikiRunWorkflow(
  params: WikiRunOpenParams,
): Promise<WikiRunWorkflowHandle> {
  if (params.abortSignal) {
    bindRunAbortSignal(params.runId, params.abortSignal);
  }

  const release = () => {
    if (params.abortSignal) {
      unbindRunAbortSignal(params.runId);
    }
  };

  try {
    if (params.abortSignal?.aborted) {
      release();
      const err = new Error("cancelled");
      err.name = "AbortError";
      throw err;
    }

    const mastra = getMastra();
    const workflow = mastra.getWorkflow(WIKI_RUN_WORKFLOW_ID);
    const run = await workflow.createRun({ runId: params.runId });

    // Start: explicit closeOnSuspend: true (Mastra default is true; pin for ADR 0027).
    // Resume: resumeStream always closes after settlement (no closeOnSuspend in API).
    // Product needs stream end on suspend so Session pipe + result() can finalize.
    const output =
      params.kind === "resume"
        ? run.resumeStream({
            step: params.step,
            resumeData: params.resumeData,
          })
        : run.stream({
            inputData: {
              runId: params.runId,
              workspace: params.workspace,
              autoApprove: params.autoApprove,
              skipPlanConfirm: params.skipPlanConfirm,
              forcePlanConfirm: params.forcePlanConfirm,
              plan: params.plan,
            },
            closeOnSuspend: true,
          });

    return {
      runId: params.runId,
      output: output as WikiRunWorkflowHandle["output"],
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Gate id used by product REST / Session resume. */
export function stepIdForGate(gate: "plan" | "publication"): string {
  return gate === "plan" ? "plan-gate" : "publish-gate";
}
