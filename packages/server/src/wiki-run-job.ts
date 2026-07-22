/**
 * Single Wiki Run job lifecycle for headless / REST / automation entry.
 *
 * Uses Pi-based `startWikiRun` / `resumeWikiRun` from @okf-wiki/agent (no
 * Mastra / AI SDK). Owns: abort bind, status finalize, Session trajectory
 * projection, and background start/resume. HTTP routes are thin adapters.
 */

import { randomUUID } from "node:crypto";
import {
  redactErrorMessage,
  resumeWikiRun,
  startWikiRun,
} from "@okf-wiki/agent";
import {
  appendSessionMessages,
  applyLateAbortStatus,
  createOperatorSession,
  isDurableRunStatus,
  listOperatorSessions,
  loadOperatorSession,
  loadRun,
  neutralizeSessionDecisionParts,
  replaceSessionMessages,
  transition,
  updateRunRecord,
  type SessionRunEvent,
  type SessionRunState,
} from "@okf-wiki/core";
import {
  isTerminalRunStatus,
  type OperatorSession,
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

export function sessionRunStateFrom(
  session: OperatorSession | null | undefined,
  runStatus?: WikiRunRecordStatus | string | null,
  runSummary?: string | null,
): SessionRunState {
  return {
    sessionStatus: session?.status ?? "active",
    workflowPhase: session?.workflow?.phase ?? "idle",
    linkedRunId: session?.workflow?.linkedRunId,
    runStatus: runStatus ?? undefined,
    pending: session?.pending ?? null,
    plan: session?.workflow?.plan,
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

function isGateStatus(status: string | undefined): boolean {
  return status === "awaiting_plan" || status === "awaiting_publication";
}

/**
 * Append high-level trajectory to the Session linked to this run.
 * Thin I/O over P2 `transition` (ADR 0026 I3).
 */
export async function projectRunStatusToSession(
  rootPath: string,
  runId: string,
  patch: {
    status: WikiRunRecordStatus;
    summary?: string | null;
    plan?: WikiRunPlan | null;
    pages?: string[] | null;
    error?: string | null;
  },
): Promise<void> {
  const run = await loadRun(rootPath, runId);
  const sessionId = run?.sessionId;
  if (!sessionId) {
    return;
  }
  const session = await loadOperatorSession(rootPath, sessionId);
  if (!session) {
    return;
  }

  const state = sessionRunStateFrom(session, run?.status, run?.summary);
  const event = eventForRunPatch({ ...patch, runId });
  const patches = transition(event, state);

  if (patches.ignore && patches.ignoreReason === "durable_outcome") {
    return;
  }

  const sessionPatch = patches.session;
  const runPatch = patches.run;
  const hint = patches.appendHint;
  const phase =
    sessionPatch?.workflow?.phase ?? session.workflow?.phase ?? "idle";
  const status = sessionPatch?.status ?? session.status;
  const plan =
    sessionPatch?.workflow?.plan ??
    patch.plan ??
    run?.plan ??
    session.workflow?.plan;
  const pages = runPatch?.pages ?? patch.pages ?? run?.pages ?? undefined;
  const summary =
    hint?.text ??
    runPatch?.summary ??
    (patch.summary?.trim() ||
      run?.summary?.trim() ||
      `Wiki Run ${patch.status}`);
  const projectedRunStatus = runPatch?.status ?? patch.status;
  const pending =
    sessionPatch && "pending" in sessionPatch
      ? sessionPatch.pending
      : isGateStatus(projectedRunStatus)
        ? session.pending
        : null;

  const parts: OperatorSession["messages"][number]["parts"] = [
    {
      type: "data-run",
      id: randomUUID(),
      data: { runId, status: projectedRunStatus },
    },
    { type: "text", text: summary, state: "done" },
  ];
  if (plan && Array.isArray(plan.pages)) {
    parts.push({ type: "data-plan", id: randomUUID(), data: plan });
  }
  if (pages && pages.length > 0) {
    parts.push({
      type: "data-run-pages",
      id: randomUUID(),
      data: { pages },
    });
  }

  const baseMessages = patches.neutralizeDecisions
    ? neutralizeSessionDecisionParts(session.messages)
    : session.messages;

  const workflow = {
    ...session.workflow,
    linkedRunId: runId,
    phase,
    ...(plan ? { plan } : {}),
    ...(sessionPatch?.workflow?.notes !== undefined
      ? { notes: sessionPatch.workflow.notes }
      : {}),
  };

  try {
    if (patches.neutralizeDecisions) {
      await replaceSessionMessages(rootPath, sessionId, baseMessages, {
        status,
        pending: null,
        workflow,
      });
    }
    await appendSessionMessages(
      rootPath,
      sessionId,
      [
        {
          id: randomUUID(),
          role: "assistant",
          parts,
          createdAt: new Date().toISOString(),
        },
      ],
      {
        status,
        pending,
        workflow,
      },
    );
  } catch (error) {
    process.stderr.write(
      `session trajectory append failed: ${redactErrorMessage(error)}\n`,
    );
  }
}

/** Prefer existing latest session; otherwise create one for headless runs. */
export async function ensureWorkspaceSessionId(
  workspace: WorkspaceConfig,
): Promise<string> {
  const existing = await listOperatorSessions(workspace.rootPath);
  const match =
    existing.find((s) => s.workspaceId === workspace.id) ?? existing[0];
  if (match) {
    return match.id;
  }
  const created = await createOperatorSession({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    title: `Wiki Session · ${workspace.name}`,
  });
  return created.id;
}

/**
 * Persist run status + project to linked Session via P2 transition.
 * Shared by background job and REST cancel cleanup paths.
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
    await projectRunStatusToSession(rootPath, runId, {
      status: "cancelled",
      summary: updated.summary ?? "Wiki Run cancelled",
    });
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

  await projectRunStatusToSession(rootPath, runId, {
    status: updated.status,
    summary: updated.summary ?? patch.summary,
    plan: patch.plan ?? updated.plan,
    pages: patch.pages ?? updated.pages,
    error: updated.error ?? patch.error,
  });
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

/**
 * Cancel product abort + optional linked Session gate cleanup.
 * Call after run record is marked cancelled.
 */
export async function cleanupSessionAfterCancel(input: {
  workspaceRoot: string;
  workspaceId: string;
  runId: string;
  /** Status before cancel write (for transition policy). */
  priorRunStatus: WikiRunRecordStatus | string;
  priorSummary?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  const linkedSessionId = input.sessionId;
  if (!linkedSessionId) {
    return;
  }
  try {
    const linked = await loadOperatorSession(
      input.workspaceRoot,
      linkedSessionId,
    );
    if (
      !linked ||
      linked.workspaceId !== input.workspaceId ||
      (linked.workflow?.linkedRunId &&
        linked.workflow.linkedRunId !== input.runId)
    ) {
      return;
    }
    const patches = transition(
      {
        type: "Cancel",
        runId: input.runId,
        summary: "Wiki Run cancelled",
      },
      sessionRunStateFrom(linked, input.priorRunStatus, input.priorSummary),
    );
    if (!patches.ignore && patches.session) {
      const messages = patches.neutralizeDecisions
        ? neutralizeSessionDecisionParts(linked.messages)
        : linked.messages;
      await replaceSessionMessages(
        input.workspaceRoot,
        linkedSessionId,
        messages,
        {
          ...(patches.session.status !== undefined
            ? { status: patches.session.status }
            : {}),
          ...(patches.session && "pending" in patches.session
            ? { pending: patches.session.pending ?? null }
            : {}),
          workflow: {
            ...linked.workflow,
            ...(patches.session.workflow ?? {}),
            linkedRunId:
              patches.session.workflow?.linkedRunId ?? input.runId,
          },
        },
      );
    }
  } catch (error) {
    process.stderr.write(
      `session cancel cleanup failed: ${redactErrorMessage(error)}\n`,
    );
  }
}

/** Re-export for Session finalize cancel-wins (same durable rule). */
export { isDurableRunStatus, abortRun };
