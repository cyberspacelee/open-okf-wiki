/**
 * Single Wiki Run production path as a Mastra Workflow.
 * Plan / write use runWikiAgent (Mastra Agent + tools); publication uses core.
 * HITL gates use workflow suspend/resume (no Session-side materialize).
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  WikiRunPlanSchema,
  WorkspaceConfigSchema,
  type WikiRunPlan,
  type WikiRunRecordStatus,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { publishStagingToPublication } from "@okf-wiki/core";
import { z } from "zod";
import { runWikiAgent, stagingDirForRun } from "./run.js";

export const WIKI_RUN_WORKFLOW_ID = "wikiRunWorkflow";

const WikiRunWorkflowInputSchema = z.object({
  runId: z.string().min(1),
  workspace: WorkspaceConfigSchema,
  autoApprove: z.boolean().optional(),
  /**
   * When true, skip the plan-confirm suspend (operator already confirmed,
   * or planConfirm is off / autoApprove).
   */
  skipPlanConfirm: z.boolean().optional(),
  /**
   * Session (and similar conversational entrypoints) force the plan gate even
   * when workspace.planConfirm is false.
   */
  forcePlanConfirm: z.boolean().optional(),
  /** Pre-confirmed or frozen plan for write phase. */
  plan: WikiRunPlanSchema.optional(),
});

export type WikiRunWorkflowInput = z.infer<typeof WikiRunWorkflowInputSchema>;

const AfterPlanSchema = WikiRunWorkflowInputSchema.extend({
  plan: WikiRunPlanSchema.optional(),
});

const AfterWriteSchema = AfterPlanSchema.extend({
  pages: z.array(z.string()),
  summary: z.string().optional(),
});

const WikiRunWorkflowOutputSchema = z.object({
  status: z.enum([
    "awaiting_plan",
    "awaiting_publication",
    "published",
    "publication_declined",
    "failed",
    "cancelled",
  ]),
  pages: z.array(z.string()).optional(),
  plan: WikiRunPlanSchema.optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  publicationPath: z.string().optional(),
});

export type WikiRunWorkflowOutput = z.infer<typeof WikiRunWorkflowOutputSchema>;

const PlanResumeSchema = z.object({
  action: z.enum(["approve", "deny"]),
  plan: WikiRunPlanSchema.optional(),
});

const PlanSuspendSchema = z.object({
  gate: z.literal("plan"),
  plan: WikiRunPlanSchema,
});

const PublishResumeSchema = z.object({
  action: z.enum(["approve", "deny"]),
});

const PublishSuspendSchema = z.object({
  gate: z.literal("publication"),
  pages: z.array(z.string()),
  summary: z.string().optional(),
});

function needsPlanConfirm(input: {
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  skipPlanConfirm?: boolean;
  forcePlanConfirm?: boolean;
}): boolean {
  if (input.skipPlanConfirm) {
    return false;
  }
  if (input.autoApprove === true) {
    return false;
  }
  if (input.forcePlanConfirm) {
    return true;
  }
  return Boolean(input.workspace.planConfirm);
}

/** Plan generation + optional suspend for operator confirmation. */
const planGateStep = createStep({
  id: "plan-gate",
  inputSchema: WikiRunWorkflowInputSchema,
  outputSchema: AfterPlanSchema,
  resumeSchema: PlanResumeSchema,
  suspendSchema: PlanSuspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData?.action === "deny") {
      // Surface cancellation via thrown error mapped by runner.
      const err = new Error("plan declined");
      err.name = "WikiRunCancelled";
      throw err;
    }

    if (resumeData?.action === "approve") {
      const plan = resumeData.plan ?? inputData.plan;
      if (!plan) {
        throw new Error("plan approval requires a plan payload");
      }
      return { ...inputData, plan, skipPlanConfirm: true };
    }

    // Already have a plan and no confirm gate — pass through to write.
    if (inputData.plan && !needsPlanConfirm(inputData)) {
      return { ...inputData, plan: inputData.plan };
    }

    // Generate plan via the shared agent entry (fixture or live).
    const result = await runWikiAgent({
      runId: inputData.runId,
      workspace: inputData.workspace,
      autoApprove: inputData.autoApprove,
      phase: "plan",
      plan: inputData.plan,
    });

    if (result.status === "cancelled") {
      const err = new Error("cancelled");
      err.name = "WikiRunCancelled";
      throw err;
    }
    if (result.status === "failed" || !result.plan) {
      throw new Error(result.error ?? "plan phase failed");
    }

    if (!needsPlanConfirm(inputData)) {
      return { ...inputData, plan: result.plan };
    }

    return await suspend({
      gate: "plan",
      plan: result.plan,
    });
  },
});

/** Write Staging Wiki via runWikiAgent (single production path). */
const writeStep = createStep({
  id: "write",
  inputSchema: AfterPlanSchema,
  outputSchema: AfterWriteSchema,
  execute: async ({ inputData }) => {
    const result = await runWikiAgent({
      runId: inputData.runId,
      workspace: inputData.workspace,
      autoApprove: inputData.autoApprove,
      phase: "write",
      plan: inputData.plan,
    });

    if (result.status === "cancelled") {
      const err = new Error("cancelled");
      err.name = "WikiRunCancelled";
      throw err;
    }
    if (result.status === "failed") {
      throw new Error(result.error ?? "write phase failed");
    }
    if (!result.pages?.length) {
      throw new Error("write phase produced no pages");
    }

    return {
      ...inputData,
      pages: result.pages,
      summary: result.summary,
      plan: result.plan ?? inputData.plan,
    };
  },
});

/** Publication gate: suspend unless autoApprove; then atomic publish via core. */
const publishGateStep = createStep({
  id: "publish-gate",
  inputSchema: AfterWriteSchema,
  outputSchema: WikiRunWorkflowOutputSchema,
  resumeSchema: PublishResumeSchema,
  suspendSchema: PublishSuspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData?.action === "deny") {
      return {
        status: "publication_declined" as const,
        pages: inputData.pages,
        plan: inputData.plan,
        summary: inputData.summary ?? "Publication declined",
      };
    }

    const shouldAuto =
      inputData.autoApprove === true || resumeData?.action === "approve";

    if (!shouldAuto) {
      return await suspend({
        gate: "publication",
        pages: inputData.pages,
        summary: inputData.summary,
      });
    }

    const stagingDir = stagingDirForRun(
      inputData.workspace.rootPath,
      inputData.runId,
    );
    const published = await publishStagingToPublication({
      stagingDir,
      publicationPath: inputData.workspace.publicationPath,
      runId: inputData.runId,
    });

    return {
      status: "published" as const,
      pages: inputData.pages,
      plan: inputData.plan,
      summary:
        inputData.summary ??
        `Published ${published.pageCount} page(s)`,
      publicationPath: published.publicationPath,
    };
  },
});

/**
 * End-to-end Wiki Run workflow.
 * Product runId is used as the Mastra workflow run id for resume correlation.
 */
export const wikiRunWorkflow = createWorkflow({
  id: WIKI_RUN_WORKFLOW_ID,
  inputSchema: WikiRunWorkflowInputSchema,
  outputSchema: WikiRunWorkflowOutputSchema,
})
  .then(planGateStep)
  .then(writeStep)
  .then(publishGateStep)
  .commit();

/** Map a successful workflow terminal result to a product status. */
export function workflowOutputToStatus(
  output: WikiRunWorkflowOutput,
): WikiRunRecordStatus {
  return output.status;
}

export type { WikiRunPlan };
