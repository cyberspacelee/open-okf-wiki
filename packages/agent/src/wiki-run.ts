/**
 * Product-facing Wiki Run orchestration over the Mastra wiki-run workflow.
 * Server/Session call this instead of Session-local materialize or ad-hoc agent glue.
 */

import type {
  WikiRunPlan,
  WikiRunRecordStatus,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { getMastra } from "./mastra-instance.js";
import {
  WIKI_RUN_WORKFLOW_ID,
  type WikiRunWorkflowOutput,
} from "./wiki-workflow.js";
import { redactErrorMessage } from "./run.js";
import {
  mapWorkflowStreamEvent,
  type WikiWorkflowJobEvent,
} from "./workflow-events.js";

export type StartWikiRunInput = {
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  /** Skip plan-confirm suspend (write with optional plan). */
  skipPlanConfirm?: boolean;
  /** Session conversational entry forces plan gate. */
  forcePlanConfirm?: boolean;
  plan?: WikiRunPlan;
  /** Job timeline callback (Run console SSE). */
  onEvent?: (event: WikiWorkflowJobEvent) => void;
};

export type WikiRunOrchestrationResult = {
  status: WikiRunRecordStatus;
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  error?: string;
  publicationPath?: string;
  /** True when workflow is suspended waiting for operator resume. */
  suspended?: boolean;
  suspendGate?: "plan" | "publication";
};

function isCancelledError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string }).name;
  if (name === "WikiRunCancelled" || name === "AbortError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /plan declined|cancelled/i.test(message);
}

function mapSuspendedResult(result: {
  status: string;
  suspended?: unknown;
  suspendPayload?: unknown;
  steps?: Record<string, { suspendPayload?: unknown; status?: string; output?: unknown }>;
}): WikiRunOrchestrationResult | null {
  if (result.status !== "suspended") {
    return null;
  }

  type GatePayload = {
    gate?: string;
    plan?: WikiRunPlan;
    pages?: string[];
    summary?: string;
  };

  const payloads: GatePayload[] = [];

  // Top-level suspend payload (current gate only).
  if (result.suspendPayload && typeof result.suspendPayload === "object") {
    payloads.push(result.suspendPayload as GatePayload);
  }

  // Only steps that are still suspended — completed steps may retain old suspendPayload.
  const steps = result.steps ?? {};
  for (const step of Object.values(steps)) {
    if (step?.status !== "suspended") {
      continue;
    }
    if (step.suspendPayload && typeof step.suspendPayload === "object") {
      payloads.push(step.suspendPayload as GatePayload);
    }
  }

  for (const payload of payloads) {
    if (payload.gate === "plan" && payload.plan) {
      return {
        status: "awaiting_plan",
        plan: payload.plan,
        summary: "Awaiting plan confirmation",
        suspended: true,
        suspendGate: "plan",
      };
    }
    if (payload.gate === "publication") {
      return {
        status: "awaiting_publication",
        pages: payload.pages,
        summary: payload.summary ?? "Awaiting publication approval",
        suspended: true,
        suspendGate: "publication",
      };
    }
  }

  // Fallback: treat unknown suspend as needs_input.
  return {
    status: "needs_input",
    summary: "Workflow suspended",
    suspended: true,
  };
}

function mapSuccessResult(result: {
  status: string;
  result?: WikiRunWorkflowOutput;
}): WikiRunOrchestrationResult {
  const output = result.result;
  if (!output) {
    return {
      status: "failed",
      error: "workflow finished without output",
    };
  }
  return {
    status: output.status,
    pages: output.pages,
    plan: output.plan,
    summary: output.summary,
    error: output.error,
    publicationPath: output.publicationPath,
  };
}

async function consumeWorkflowStream(
  output: {
    fullStream?: AsyncIterable<unknown>;
    result: Promise<unknown>;
  },
  onEvent?: (event: WikiWorkflowJobEvent) => void,
): Promise<unknown> {
  if (onEvent && output.fullStream) {
    try {
      for await (const event of output.fullStream) {
        const mapped = mapWorkflowStreamEvent(event);
        if (mapped) {
          onEvent(mapped);
        }
      }
    } catch {
      // Stream iteration errors surface via result; keep job timeline best-effort.
    }
  }
  return output.result;
}

function mapTerminalWorkflowResult(result: unknown): WikiRunOrchestrationResult {
  const suspended = mapSuspendedResult(result as never);
  if (suspended) {
    return suspended;
  }
  if ((result as { status?: string }).status === "failed") {
    const err =
      (result as { error?: unknown }).error ??
      (result as { steps?: unknown }).steps;
    return {
      status: "failed",
      error: redactErrorMessage(err ?? "workflow failed"),
    };
  }
  return mapSuccessResult(result as never);
}

/**
 * Start (or re-create) the wiki-run workflow for a product run id.
 * Prefer stream() so Run console can mirror workflow step events.
 */
export async function startWikiRun(
  input: StartWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  try {
    const mastra = getMastra();
    const workflow = mastra.getWorkflow(WIKI_RUN_WORKFLOW_ID);
    const run = await workflow.createRun({ runId: input.runId });
    const output = run.stream({
      inputData: {
        runId: input.runId,
        workspace: input.workspace,
        autoApprove: input.autoApprove,
        skipPlanConfirm: input.skipPlanConfirm,
        forcePlanConfirm: input.forcePlanConfirm,
        plan: input.plan,
      },
    });

    const result = await consumeWorkflowStream(output, input.onEvent);
    return mapTerminalWorkflowResult(result);
  } catch (error) {
    if (isCancelledError(error)) {
      return {
        status: "cancelled",
        error: "cancelled",
        summary: "Wiki Run cancelled",
      };
    }
    return {
      status: "failed",
      error: redactErrorMessage(error),
    };
  }
}

export type ResumeWikiRunInput = {
  runId: string;
  /** plan-gate or publish-gate */
  gate: "plan" | "publication";
  action: "approve" | "deny";
  plan?: WikiRunPlan;
  onEvent?: (event: WikiWorkflowJobEvent) => void;
};

/**
 * Resume a suspended wiki-run workflow (plan or publication HITL).
 */
export async function resumeWikiRun(
  input: ResumeWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  try {
    const mastra = getMastra();
    const workflow = mastra.getWorkflow(WIKI_RUN_WORKFLOW_ID);
    const run = await workflow.createRun({ runId: input.runId });

    const resumeData =
      input.gate === "plan"
        ? { action: input.action, plan: input.plan }
        : { action: input.action };

    const step = input.gate === "plan" ? "plan-gate" : "publish-gate";
    const output = run.resumeStream({
      step,
      resumeData,
    });

    const result = await consumeWorkflowStream(output, input.onEvent);
    return mapTerminalWorkflowResult(result);
  } catch (error) {
    if (isCancelledError(error)) {
      return {
        status: "cancelled",
        error: "cancelled",
        summary: "Wiki Run cancelled",
      };
    }
    return {
      status: "failed",
      error: redactErrorMessage(error),
    };
  }
}

export type { WikiWorkflowJobEvent };
