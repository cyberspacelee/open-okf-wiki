/**
 * Session projection adapter: Mastra wiki-run → AI SDK UI stream (toAISdkStream).
 * Opening/abort bind lives in wiki-run-orchestrator (ADR 0025).
 */

import { toAISdkStream } from "@mastra/ai-sdk";
import type { UIMessageChunk } from "ai";
import type { WikiRunPlan, WorkspaceConfig } from "@okf-wiki/contract";
import {
  openWikiRunWorkflow,
  type WikiRunOpenParams,
} from "./wiki-run-orchestrator.js";

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
  resumeData: {
    action: "approve" | "deny" | "revise";
    plan?: WikiRunPlan;
    feedback?: string;
  };
  /** Product cancel signal (server abortRun). Bound for workflow steps. */
  abortSignal?: AbortSignal;
};

/**
 * Open a wiki-run workflow stream converted with @mastra/ai-sdk toAISdkStream.
 * Exposes result() so Session finalize can map suspend/terminal once.
 */
export async function openWikiWorkflowUiStream(
  params: WikiWorkflowUiStart | WikiWorkflowUiResume,
): Promise<{
  stream: ReadableStream<UIMessageChunk>;
  result: () => Promise<unknown>;
}> {
  const openParams: WikiRunOpenParams =
    params.kind === "resume"
      ? {
          kind: "resume",
          runId: params.runId,
          step: params.step,
          resumeData: params.resumeData,
          abortSignal: params.abortSignal,
        }
      : {
          kind: "start",
          runId: params.runId,
          workspace: params.workspace,
          autoApprove: params.autoApprove,
          skipPlanConfirm: params.skipPlanConfirm,
          forcePlanConfirm: params.forcePlanConfirm,
          plan: params.plan,
          abortSignal: params.abortSignal,
        };

  const handle = await openWikiRunWorkflow(openParams);

  // Raw AI SDK chunks — no nested createUIMessageStream (avoids duplicate assistant ids).
  // includeTextStreamParts + sendReasoning: forward nested agent text/tools/reasoning
  // written via step writer (runWikiAgent fullStream pipe) — ADR 0026.
  const stream = toAISdkStream(handle.output as never, {
    from: "workflow",
    includeTextStreamParts: true,
    sendReasoning: true,
  }) as unknown as ReadableStream<UIMessageChunk>;

  // Unbind after the workflow result settles (success, suspend, or error).
  // Do not unbind on stream cancel alone — result() may still be awaited.
  const result = () => handle.output.result.finally(handle.release);

  return { stream, result };
}
