/**
 * Single Wiki Run job lifecycle for headless / REST / automation entry.
 *
 * Uses Pi-based `startWikiRun` / `resumeWikiRun` from @okf-wiki/agent.
 * Owns: abort bind, status finalize, Run Record updates. HTTP routes are thin.
 * No UIMessage Operator Session trajectory (ADR 0030).
 */

import { randomUUID } from "node:crypto";
import {
  redactErrorMessage,
  resolveModelSelection,
  resolveWorkspacePiModel,
  resumeWikiRun,
  shouldUsePiFixtureMode,
  startWikiRun,
  type WikiRunModelFactory,
} from "@okf-wiki/agent";
import {
  applyLateAbortStatus,
  isDurableRunStatus,
  loadRun,
  transition,
  updateRunRecord,
  type SessionRunEvent,
  type SessionRunState,
} from "@okf-wiki/core";
import {
  isTerminalRunStatus,
  type WikiRunPlan,
  type WikiRunRecordStatus,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  abortRun,
  clearRunAbortController,
  emitRunDone,
  emitRunEvent,
  emitRunStatus,
  registerRunAbortController,
} from "./run-events.ts";

/** Settings-backed model factory for headless/live Wiki Runs. */
function resolveModelForWorkspace(
  workspace: WorkspaceConfig,
): WikiRunModelFactory | undefined {
  if (shouldUsePiFixtureMode({})) return undefined;
  return async (role) => {
    const selection = resolveModelSelection({
      workspace,
      role: role === "planner" ? "planner" : "writer",
    });
    const resolved = await resolveWorkspacePiModel({
      profileId: selection.profileId,
      modelId: selection.id,
    });
    return {
      model: resolved.model,
      modelRuntime: resolved.modelRuntime,
      maxContextTokens: resolved.runtime.maxContextTokens,
      profileId: resolved.runtime.profileId,
    };
  };
}

export function sessionRunStateFrom(
  runStatus?: WikiRunRecordStatus | string | null,
  runSummary?: string | null,
  linkedRunId?: string | null,
): SessionRunState {
  return {
    sessionStatus: "active",
    workflowPhase: "idle",
    linkedRunId: linkedRunId ?? undefined,
    runStatus: runStatus ?? undefined,
    pending: null,
    plan: undefined,
    summary: runSummary ?? undefined,
  };
}

export function eventForRunPatch(patch: {
  status: WikiRunRecordStatus;
  summary?: string | null;
  plan?: WikiRunPlan | null;
  pages?: string[] | null;
  error?: string | null;
  runId?: string;
}): SessionRunEvent {
  if (patch.status === "cancelled") {
    return {
      type: "Cancel",
      runId: patch.runId,
      summary: patch.summary ?? "Wiki Run cancelled",
    };
  }
  if (patch.status === "awaiting_plan") {
    return {
      type: "WorkflowSuspended",
      runId: patch.runId,
      gate: "plan",
      plan: patch.plan ?? undefined,
      pages: patch.pages ?? undefined,
      summary: patch.summary ?? undefined,
    };
  }
  if (patch.status === "awaiting_publication") {
    return {
      type: "WorkflowSuspended",
      runId: patch.runId,
      gate: "publication",
      plan: patch.plan ?? undefined,
      pages: patch.pages ?? undefined,
      summary: patch.summary ?? undefined,
    };
  }
  if (patch.status === "running") {
    return {
      type: "WorkflowLive",
      runId: patch.runId ?? "unknown",
    };
  }
  return {
    type: "WorkflowTerminal",
    runId: patch.runId,
    status: patch.status,
    plan: patch.plan ?? undefined,
    pages: patch.pages ?? undefined,
    summary: patch.summary ?? undefined,
    error: patch.error,
  };
}

/** Opaque correlation id for headless runs (not a UIMessage session file). */
export async function ensureWorkspaceSessionId(
  _workspace: WorkspaceConfig,
): Promise<string> {
  return randomUUID();
}

/**
 * Persist run status via pure transition policy + Run Record.
 * Shared by background job and REST cancel paths.
 */
export async function finalizeRunStatus(
  rootPath: string,
  runId: string,
  patch: {
    status: WikiRunRecordStatus;
    error?: string | null;
    pages?: string[] | null;
    summary?: string | null;
    plan?: WikiRunPlan | null;
  },
): Promise<void> {
  const existing = await loadRun(rootPath, runId);
  const state: SessionRunState = {
    sessionStatus: "active",
    workflowPhase: "idle",
    linkedRunId: runId,
    runStatus: existing?.status,
    plan: existing?.plan,
    pages: existing?.pages,
    summary: existing?.summary,
  };
  const event = eventForRunPatch({ ...patch, runId });
  const pure = transition(event, state);

  if (pure.ignore && pure.ignoreReason === "cancel_wins") {
    emitRunDone(runId, "cancelled", existing?.summary ?? "Wiki Run cancelled");
    return;
  }
  if (pure.ignore && pure.ignoreReason === "durable_outcome") {
    if (existing && isTerminalRunStatus(existing.status)) {
      emitRunDone(
        runId,
        existing.status,
        existing.error ?? existing.summary ?? existing.status,
      );
    }
    return;
  }

  const runFields = pure.run;
  const updated = await updateRunRecord(rootPath, runId, {
    status: runFields?.status ?? patch.status,
    error:
      runFields?.error !== undefined ? runFields.error : patch.error,
    pages: runFields?.pages ?? patch.pages,
    summary: runFields?.summary ?? patch.summary,
    ...(patch.plan !== undefined || runFields?.plan !== undefined
      ? { plan: runFields?.plan ?? patch.plan }
      : {}),
  });

  if (updated.status === "cancelled" && patch.status !== "cancelled") {
    emitRunDone(runId, "cancelled", updated.summary ?? "Wiki Run cancelled");
    return;
  }

  if (isTerminalRunStatus(updated.status)) {
    emitRunDone(
      runId,
      updated.status,
      updated.error ?? updated.summary ?? updated.status,
    );
  } else {
    emitRunStatus(runId, updated.status, updated.summary ?? updated.status);
  }
}

type ProcessRunOptions = {
  autoApprove?: boolean;
  phase?: "plan" | "write";
  plan?: WikiRunPlan;
};

function jobEventsToSse(runId: string) {
  return (event: { type: string; message?: string; data?: unknown }) => {
    const detail =
      event.message ??
      (event.data !== undefined ? JSON.stringify(event.data) : event.type);
    emitRunEvent(runId, {
      type: "log",
      message: detail,
    });
  };
}

async function persistWorkflowResult(
  rootPath: string,
  runId: string,
  result: {
    status: string;
    pages?: string[];
    summary?: string;
    plan?: WikiRunPlan;
    error?: string;
  },
  abortSignal: AbortSignal,
  planFallback?: WikiRunPlan,
): Promise<void> {
  const adjusted = applyLateAbortStatus(result, abortSignal.aborted);
  const status = adjusted.status as WikiRunRecordStatus;
  const plan =
    ("plan" in adjusted ? adjusted.plan : undefined) ??
    result.plan ??
    planFallback ??
    null;

  if (status === "awaiting_plan") {
    await finalizeRunStatus(rootPath, runId, {
      status: "awaiting_plan",
      error: null,
      pages: result.pages ?? null,
      summary:
        ("summary" in adjusted && typeof adjusted.summary === "string"
          ? adjusted.summary
          : null) ??
        result.summary ??
        "Awaiting plan confirmation",
      plan,
    });
    if (result.plan) {
      emitRunEvent(runId, {
        type: "part",
        partType: "data-plan",
        message: result.plan.summary ?? "plan ready",
        text: JSON.stringify(result.plan),
      });
    }
    return;
  }

  if (status === "awaiting_publication") {
    await finalizeRunStatus(rootPath, runId, {
      status: "awaiting_publication",
      error: null,
      pages: result.pages ?? null,
      summary: result.summary ?? "Awaiting publication approval",
      plan,
    });
    return;
  }

  await finalizeRunStatus(rootPath, runId, {
    status,
    error:
      status === "cancelled"
        ? "cancelled"
        : ((("error" in adjusted
            ? (adjusted as { error?: string }).error
            : result.error) ?? null) as string | null),
    pages: result.pages ?? null,
    summary:
      ("summary" in adjusted && typeof adjusted.summary === "string"
        ? adjusted.summary
        : null) ??
      result.summary ??
      null,
    ...(plan ? { plan } : {}),
  });
}

/**
 * Background Wiki Run via Pi startWikiRun + WikiRunShell.
 * Plan/write/publish gates live in the shell; autoApprove skips suspends.
 */
export function processRunInBackground(
  workspace: WorkspaceConfig,
  runId: string,
  options: ProcessRunOptions = {},
): void {
  const autoApprove = options.autoApprove;
  const skipPlanConfirm =
    options.phase === "write" ||
    Boolean(options.plan) ||
    autoApprove === true ||
    !workspace.planConfirm;

  void (async () => {
    const abortSignal = registerRunAbortController(runId);
    emitRunStatus(
      runId,
      "running",
      skipPlanConfirm ? "Wiki Run started" : "Wiki Run plan phase started",
    );
    emitRunEvent(runId, {
      type: "log",
      message: skipPlanConfirm
        ? "wiki workflow started"
        : "wiki workflow plan phase started",
    });

    try {
      if (abortSignal.aborted) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          summary: "Wiki Run cancelled",
        });
        return;
      }

      const result = await startWikiRun({
        runId,
        workspace,
        autoApprove,
        skipPlanConfirm,
        plan: options.plan,
        abortSignal,
        resolveModel: resolveModelForWorkspace(workspace),
        onEvent: jobEventsToSse(runId),
      });

      if (
        result.status !== "awaiting_plan" &&
        result.status !== "awaiting_publication"
      ) {
        emitRunEvent(runId, {
          type: "log",
          message: result.summary ?? `workflow finished: ${result.status}`,
        });
      }

      await persistWorkflowResult(
        workspace.rootPath,
        runId,
        result,
        abortSignal,
        options.plan,
      );
    } catch (error) {
      process.stderr.write(
        `run ${runId} failed: ${redactErrorMessage(error)}\n`,
      );
      try {
        const status: WikiRunRecordStatus = abortSignal.aborted
          ? "cancelled"
          : "failed";
        await finalizeRunStatus(workspace.rootPath, runId, {
          status,
          error:
            status === "cancelled" ? "cancelled" : redactErrorMessage(error),
          summary: status === "cancelled" ? "Wiki Run cancelled" : undefined,
        });
      } catch (updateError) {
        process.stderr.write(
          `run ${runId} status update failed: ${redactErrorMessage(updateError)}\n`,
        );
      }
    } finally {
      clearRunAbortController(runId);
    }
  })();
}

/**
 * Resume a suspended wiki-run (plan or publication) via Pi resumeWikiRun.
 */
export function resumeRunInBackground(
  workspace: WorkspaceConfig,
  runId: string,
  gate: "plan" | "publication",
  action: "approve" | "deny" | "revise",
  plan?: WikiRunPlan,
  feedback?: string,
): void {
  void (async () => {
    const abortSignal = registerRunAbortController(runId);
    const statusMessage =
      gate === "plan"
        ? action === "revise"
          ? "Revising plan from operator feedback"
          : "Resuming after plan decision"
        : "Resuming after publication decision";
    emitRunStatus(runId, "running", statusMessage);
    try {
      if (abortSignal.aborted) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          summary: "Wiki Run cancelled",
        });
        return;
      }

      const existing = await loadRun(workspace.rootPath, runId);
      const resolvedPlan = plan ?? existing?.plan ?? undefined;
      const pages = existing?.pages ?? undefined;
      const step = gate === "publication" ? "publish-gate" : "plan-gate";

      const result = await resumeWikiRun({
        runId,
        workspace,
        step,
        resumeData: {
          action,
          plan: resolvedPlan,
          feedback,
        },
        plan: resolvedPlan,
        pages,
        abortSignal,
        resolveModel: resolveModelForWorkspace(workspace),
        onEvent: jobEventsToSse(runId),
      });

      await persistWorkflowResult(
        workspace.rootPath,
        runId,
        result,
        abortSignal,
        resolvedPlan,
      );
    } catch (error) {
      process.stderr.write(
        `run ${runId} resume failed: ${redactErrorMessage(error)}\n`,
      );
      try {
        const status: WikiRunRecordStatus = abortSignal.aborted
          ? "cancelled"
          : "failed";
        await finalizeRunStatus(workspace.rootPath, runId, {
          status,
          error:
            status === "cancelled" ? "cancelled" : redactErrorMessage(error),
          summary: status === "cancelled" ? "Wiki Run cancelled" : undefined,
        });
      } catch {
        // best-effort status write
      }
    } finally {
      clearRunAbortController(runId);
    }
  })();
}

/** Re-export for cancel-wins policy + abort. */
export { isDurableRunStatus, abortRun };
