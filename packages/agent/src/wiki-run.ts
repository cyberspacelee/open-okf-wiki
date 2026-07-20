/**
 * Run console / headless job projection over the wiki-run workflow.
 * Open + abort bind: wiki-run-orchestrator; terminal map: workflow-result.
 */

import type { WikiRunPlan, WorkspaceConfig } from "@okf-wiki/contract";
import { redactErrorMessage } from "./run.js";
import {
  openWikiRunWorkflow,
  stepIdForGate,
} from "./wiki-run-orchestrator.js";
import { applyLateAbortStatus } from "@okf-wiki/core";
import {
  mapWorkflowResult,
  type WikiWorkflowTerminal,
} from "./workflow-result.js";
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
  /**
   * Product cancel signal (server registerRunAbortController / abortRun).
   * Bound for workflow steps so runWikiAgent stops mid-phase.
   */
  abortSignal?: AbortSignal;
};

/** Job/orchestration result — same shape as unified WikiWorkflowTerminal. */
export type WikiRunOrchestrationResult = WikiWorkflowTerminal;

function isCancelledError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string }).name;
  if (name === "WikiRunCancelled" || name === "AbortError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /plan declined|cancelled|aborted/i.test(message);
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

function cancelledResult(): WikiRunOrchestrationResult {
  return {
    status: "cancelled",
    error: "cancelled",
    summary: "Wiki Run cancelled",
  };
}

/**
 * Start (or re-create) the wiki-run workflow for a product run id.
 * Prefer stream() so Run console can mirror workflow step events.
 */
export async function startWikiRun(
  input: StartWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) {
    return cancelledResult();
  }
  let release: (() => void) | undefined;
  try {
    const handle = await openWikiRunWorkflow({
      kind: "start",
      runId: input.runId,
      workspace: input.workspace,
      autoApprove: input.autoApprove,
      skipPlanConfirm: input.skipPlanConfirm,
      forcePlanConfirm: input.forcePlanConfirm,
      plan: input.plan,
      abortSignal: input.abortSignal,
    });
    release = handle.release;
    const result = await consumeWorkflowStream(handle.output, input.onEvent);
    return applyLateAbortStatus(
      mapWorkflowResult(result),
      Boolean(input.abortSignal?.aborted),
    ) as WikiRunOrchestrationResult;
  } catch (error) {
    if (isCancelledError(error) || input.abortSignal?.aborted) {
      return cancelledResult();
    }
    return {
      status: "failed",
      error: redactErrorMessage(error),
    };
  } finally {
    release?.();
  }
}

export type ResumeWikiRunInput = {
  runId: string;
  /** plan-gate or publish-gate */
  gate: "plan" | "publication";
  action: "approve" | "deny";
  plan?: WikiRunPlan;
  onEvent?: (event: WikiWorkflowJobEvent) => void;
  /** Product cancel signal (server abortRun). */
  abortSignal?: AbortSignal;
};

/**
 * Resume a suspended wiki-run workflow (plan or publication HITL).
 */
export async function resumeWikiRun(
  input: ResumeWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) {
    return cancelledResult();
  }
  let release: (() => void) | undefined;
  try {
    const resumeData =
      input.gate === "plan"
        ? { action: input.action, plan: input.plan }
        : { action: input.action };

    const handle = await openWikiRunWorkflow({
      kind: "resume",
      runId: input.runId,
      step: stepIdForGate(input.gate),
      resumeData,
      abortSignal: input.abortSignal,
    });
    release = handle.release;
    const result = await consumeWorkflowStream(handle.output, input.onEvent);
    return applyLateAbortStatus(
      mapWorkflowResult(result),
      Boolean(input.abortSignal?.aborted),
    ) as WikiRunOrchestrationResult;
  } catch (error) {
    if (isCancelledError(error) || input.abortSignal?.aborted) {
      return cancelledResult();
    }
    return {
      status: "failed",
      error: redactErrorMessage(error),
    };
  } finally {
    release?.();
  }
}

export type { WikiWorkflowJobEvent };
export type { WikiWorkflowTerminal };
