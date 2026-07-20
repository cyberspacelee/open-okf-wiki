/**
 * Official Mastra → AI SDK UI stream bridge (same pattern as handleWorkflowStream).
 * Returns the UI stream plus a result() promise so product finalize can map suspend/terminal.
 */

import { toAISdkStream } from "@mastra/ai-sdk";
import { createUIMessageStream, type UIMessageChunk } from "ai";
import type { WikiRunPlan, WorkspaceConfig } from "@okf-wiki/contract";
import { getMastra } from "./mastra-instance.js";
import { WIKI_RUN_WORKFLOW_ID } from "./wiki-workflow.js";

export type WikiWorkflowUiStart = {
  kind: "start";
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  skipPlanConfirm?: boolean;
  forcePlanConfirm?: boolean;
  plan?: WikiRunPlan;
};

export type WikiWorkflowUiResume = {
  kind: "resume";
  runId: string;
  step: string;
  resumeData: { action: "approve" | "deny"; plan?: WikiRunPlan };
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

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Official conversion (same as handleWorkflowStream body).
      for await (const part of toAISdkStream(output, { from: "workflow" })) {
        writer.write(part as UIMessageChunk);
      }
    },
  });

  return {
    stream,
    result: () => output.result as Promise<unknown>,
  };
}
