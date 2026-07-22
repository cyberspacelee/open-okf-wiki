/**
 * Run console / headless job projection over the wiki-run workflow.
 *
 * Live timeline shares Session's path: openWikiRunUiProjection → toAISdkStream
 * → uiChunkToJobEvent. Terminal audit replay uses workflowSnapshotToStream
 * (ADR 0027 Phase 6 full Run SSE cutover).
 */

import type { WikiRunPlan, WorkspaceConfig } from "@okf-wiki/contract";
import { applyLateAbortStatus } from "@okf-wiki/core";
import { redactErrorMessage } from "./run-redact.js";
import { isRunCancelledError } from "./session-turn/cancel.js";
import {
  stepIdForGate,
  type WikiRunOpenParams,
} from "./wiki-run-orchestrator.js";
import { openWikiRunUiProjection } from "./workflow-ui-stream.js";
import {
  mapWorkflowResult,
  type WikiWorkflowTerminal,
} from "./workflow-result.js";
import {
  uiChunkToJobEvent,
  type WikiWorkflowJobEvent,
} from "./workflow-events.js";
import {
  loadWikiRunWorkflowSnapshot,
  openWikiRunAuditStream,
} from "./workflow-audit-stream.js";

export type StartWikiRunInput = {
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  /** Skip plan-confirm suspend (write with optional plan). */
  skipPlanConfirm?: boolean;
  /** Session conversational entry forces plan gate. */
  forcePlanConfirm?: boolean;
  plan?: WikiRunPlan;
  /** Job timeline callback (Run console SSE) — framework UI parts. */
  onEvent?: (event: WikiWorkflowJobEvent) => void;
  /**
   * Product cancel signal (server registerRunAbortController / abortRun).
   * Bound for workflow steps so runWikiAgent stops mid-phase.
   */
  abortSignal?: AbortSignal;
};

/** Job/orchestration result — same shape as unified WikiWorkflowTerminal. */
export type WikiRunOrchestrationResult = WikiWorkflowTerminal;

async function consumeUiProjection(
  stream: ReadableStream<unknown>,
  result: () => Promise<unknown>,
  onEvent?: (event: WikiWorkflowJobEvent) => void,
): Promise<unknown> {
  if (onEvent) {
    try {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const mapped = uiChunkToJobEvent(value);
          if (mapped) {
            onEvent(mapped);
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // Stream iteration errors surface via result; keep job timeline best-effort.
    }
  } else {
    // Drain so the workflow is not back-pressured when no listener.
    try {
      await stream.pipeTo(
        new WritableStream({
          write() {
            /* discard */
          },
        }),
      );
    } catch {
      // ignore
    }
  }
  return result();
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
 * Same open + toAISdkStream path as Session (openWikiRunUiProjection).
 */
export async function startWikiRun(
  input: StartWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) {
    return cancelledResult();
  }
  try {
    const params: WikiRunOpenParams = {
      kind: "start",
      runId: input.runId,
      workspace: input.workspace,
      autoApprove: input.autoApprove,
      skipPlanConfirm: input.skipPlanConfirm,
      forcePlanConfirm: input.forcePlanConfirm,
      plan: input.plan,
      abortSignal: input.abortSignal,
    };
    const handle = await openWikiRunUiProjection(params);
    const raw = await consumeUiProjection(
      handle.stream,
      handle.result,
      input.onEvent,
    );
    return applyLateAbortStatus(
      mapWorkflowResult(raw),
      Boolean(input.abortSignal?.aborted),
    ) as WikiRunOrchestrationResult;
  } catch (error) {
    if (isRunCancelledError(error) || input.abortSignal?.aborted) {
      return cancelledResult();
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
  action: "approve" | "deny" | "revise";
  plan?: WikiRunPlan;
  feedback?: string;
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
  try {
    if (input.gate === "publication" && input.action === "revise") {
      throw new Error("publication gate does not support revise");
    }
    const resumeData =
      input.gate === "plan"
        ? {
            action: input.action,
            ...(input.plan ? { plan: input.plan } : {}),
            ...(input.feedback ? { feedback: input.feedback } : {}),
          }
        : { action: input.action as "approve" | "deny" };

    const handle = await openWikiRunUiProjection({
      kind: "resume",
      runId: input.runId,
      step: stepIdForGate(input.gate),
      resumeData,
      abortSignal: input.abortSignal,
    });
    const raw = await consumeUiProjection(
      handle.stream,
      handle.result,
      input.onEvent,
    );
    return applyLateAbortStatus(
      mapWorkflowResult(raw),
      Boolean(input.abortSignal?.aborted),
    ) as WikiRunOrchestrationResult;
  } catch (error) {
    if (isRunCancelledError(error) || input.abortSignal?.aborted) {
      return cancelledResult();
    }
    return {
      status: "failed",
      error: redactErrorMessage(error),
    };
  }
}

/**
 * Replay a persisted Mastra workflow snapshot as job events (terminal audit).
 * Used by Run SSE when the ring buffer is empty but a snapshot exists.
 */
export async function replayWikiRunAuditEvents(
  runId: string,
  onEvent: (event: WikiWorkflowJobEvent) => void,
): Promise<boolean> {
  const snapshot = await loadWikiRunWorkflowSnapshot(runId);
  if (!snapshot) {
    return false;
  }
  const stream = openWikiRunAuditStream(snapshot);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const mapped = uiChunkToJobEvent(value);
      if (mapped) {
        onEvent(mapped);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return true;
}

export type { WikiWorkflowJobEvent };
export type { WikiWorkflowTerminal };
