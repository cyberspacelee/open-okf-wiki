/**
 * Official Mastra → AI SDK UI stream bridge (same pattern as handleWorkflowStream).
 * Returns the UI stream plus a result() promise so product finalize can map suspend/terminal.
 *
 * Does NOT wrap in createUIMessageStream — callers that own the Session turn
 * (createSessionWorkflowStream) already use createUIMessageStream with
 * originalMessages so workflow parts merge into one assistant bubble.
 */

import { toAISdkStream } from "@mastra/ai-sdk";
import type { UIMessageChunk } from "ai";
import type { WikiRunPlan, WorkspaceConfig } from "@okf-wiki/contract";
import { getMastra } from "./mastra-instance.js";
import {
  bindRunAbortSignal,
  unbindRunAbortSignal,
} from "./run-abort.js";
import { WIKI_RUN_WORKFLOW_ID } from "./wiki-workflow.js";

export type WikiWorkflowUiStart = {
  kind: "start";
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  skipPlanConfirm?: boolean;
  forcePlanConfirm?: boolean;
  plan?: WikiRunPlan;
  /** Product cancel signal (server abortRun). Bound for workflow steps. */
  abortSignal?: AbortSignal;
};

export type WikiWorkflowUiResume = {
  kind: "resume";
  runId: string;
  step: string;
  resumeData: { action: "approve" | "deny"; plan?: WikiRunPlan };
  /** Product cancel signal (server abortRun). Bound for workflow steps. */
  abortSignal?: AbortSignal;
};

/**
 * Open a wiki-run workflow stream converted with @mastra/ai-sdk toAISdkStream.
 * Mirrors handleWorkflowStream internals while exposing result() for product side effects.
 */
export async function openWikiWorkflowUiStream(
  params: WikiWorkflowUiStart | WikiWorkflowUiResume,
): Promise<{
  stream: ReadableStream<UIMessageChunk>;
  result: () => Promise<unknown>;
}> {
  if (params.abortSignal) {
    bindRunAbortSignal(params.runId, params.abortSignal);
  }

  const release = () => {
    if (params.abortSignal) {
      unbindRunAbortSignal(params.runId);
    }
  };

  try {
    const mastra = getMastra();
    const workflow = mastra.getWorkflow(WIKI_RUN_WORKFLOW_ID);
    const run = await workflow.createRun({ runId: params.runId });

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
          });

    // Raw AI SDK chunks — no nested createUIMessageStream (avoids duplicate assistant ids).
    const stream = toAISdkStream(output, {
      from: "workflow",
    }) as unknown as ReadableStream<UIMessageChunk>;

    // Unbind after the workflow result settles (success, suspend, or error).
    // Do not unbind on stream cancel alone — result() may still be awaited.
    const result = () =>
      (output.result as Promise<unknown>).finally(release);

    return {
      stream,
      result,
    };
  } catch (error) {
    release();
    throw error;
  }
}
