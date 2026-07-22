/**
 * HTTP adapters for Wiki Run jobs (list/create/retry/HITL/SSE/cancel).
 * Job lifecycle lives in wiki-run-job.ts — same start/resumeWikiRun as Session.
 * REST approve/deny is automation-only; humans use Session (ADR 0026/0029).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { replayWikiRunAuditEvents } from "@okf-wiki/agent";
import {
  createRun,
  listRuns,
  loadRun,
  loadWorkspaceById,
  probeLocalGit,
  resolveSkillPath,
  skillDigest,
  RunStatusConflictError,
  updateRunRecord,
} from "@okf-wiki/core";
import {
  isTerminalRunStatus,
  WikiRunPlanSchema,
} from "@okf-wiki/contract";
import type { RunSseEvent } from "@okf-wiki/contract";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import {
  emitRunDone,
  emitRunEvent,
  getRecentRunEvents,
  subscribeRunEvents,
} from "../run-events.ts";
import {
  abortRun,
  cleanupSessionAfterCancel,
  ensureWorkspaceSessionId,
  processRunInBackground,
  resumeRunInBackground,
} from "../wiki-run-job.ts";

// Re-export job APIs for tests / callers that imported from routes/runs.
export {
  ensureWorkspaceSessionId,
  finalizeRunStatus,
  processRunInBackground,
  projectRunStatusToSession,
  resumeRunInBackground,
} from "../wiki-run-job.ts";

async function loadWorkspaceOr404(
  res: ServerResponse,
  id: string,
  url: URL,
) {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, {
    rootPath: rootPath ?? undefined,
  });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return null;
  }
  return workspace;
}

async function assertSourcesClean(
  res: ServerResponse,
  workspace: NonNullable<Awaited<ReturnType<typeof loadWorkspaceById>>>,
): Promise<boolean> {
  if (!workspace.sources || workspace.sources.length === 0) {
    sendError(
      res,
      400,
      "workspace must have at least one source before starting a run",
    );
    return false;
  }
  for (const source of workspace.sources) {
    const probe = await probeLocalGit(source.path);
    if (!probe.isGit) {
      sendError(
        res,
        400,
        `source "${source.id}" is not a git working tree: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return false;
    }
    if (probe.dirty) {
      sendError(
        res,
        400,
        `source "${source.id}" has a dirty git working tree; commit or stash before starting a run: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return false;
    }
  }
  return true;
}

export async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  if (!(await assertSourcesClean(res, workspace))) return;

  const body = (await readJsonBody(req)) as { autoApprove?: unknown };
  const autoApprove =
    typeof body.autoApprove === "boolean" ? body.autoApprove : undefined;

  let frozenSkillPath: string;
  let frozenSkillDigest: string;
  try {
    frozenSkillPath = await resolveSkillPath({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    frozenSkillDigest = await skillDigest(frozenSkillPath);
  } catch (error) {
    sendError(
      res,
      400,
      error instanceof Error ? error.message : "failed to freeze producer skill",
    );
    return;
  }

  const sessionId = await ensureWorkspaceSessionId(workspace);
  const run = await createRun(workspace.rootPath, workspace.id, {
    autoApprove,
    skillPath: frozenSkillPath,
    skillDigest: frozenSkillDigest,
    sessionId,
  });
  processRunInBackground(workspace, run.runId, { autoApprove });
  sendJson(res, 201, { run });
}

/** Manual Retry: new run, frozen skill from prior record (ADR 0012). */
export async function handleRetryRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  if (!(await assertSourcesClean(res, workspace))) return;

  const previous = await loadRun(workspace.rootPath, runId);
  if (!previous || previous.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (
    previous.status === "running" ||
    previous.status === "awaiting_plan" ||
    previous.status === "awaiting_publication" ||
    previous.status === "needs_input"
  ) {
    sendError(
      res,
      409,
      `cannot retry an in-progress run (status: ${previous.status})`,
    );
    return;
  }

  let frozenSkillPath = previous.skillPath;
  let frozenSkillDigest = previous.skillDigest;
  try {
    if (!frozenSkillPath) {
      frozenSkillPath = await resolveSkillPath({
        skillPath: workspace.skillPath,
        workspaceRoot: workspace.rootPath,
      });
    }
    if (!frozenSkillDigest) {
      frozenSkillDigest = await skillDigest(frozenSkillPath);
    } else {
      await resolveSkillPath({ skillPath: frozenSkillPath });
    }
  } catch (error) {
    sendError(
      res,
      400,
      error instanceof Error
        ? error.message
        : "failed to resolve frozen skill for retry",
    );
    return;
  }

  const sessionId =
    previous.sessionId ?? (await ensureWorkspaceSessionId(workspace));
  const run = await createRun(workspace.rootPath, workspace.id, {
    autoApprove: previous.autoApprove,
    skillPath: frozenSkillPath,
    skillDigest: frozenSkillDigest,
    sessionId,
  });
  processRunInBackground(workspace, run.runId, {
    autoApprove: previous.autoApprove,
  });
  sendJson(res, 201, {
    run,
    retriedFrom: previous.runId,
    skillDigest: frozenSkillDigest,
  });
}

/** Automation HITL: approve plan (humans use Session). */
export async function handleApprovePlan(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const existing = await loadRun(workspace.rootPath, runId);
  if (!existing) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (existing.status !== "awaiting_plan") {
    sendError(res, 409, `run is not awaiting plan (status: ${existing.status})`);
    return;
  }

  const body = (await readJsonBody(req)) as { notes?: unknown; plan?: unknown };
  let plan = existing.plan;
  if (body.plan !== undefined) {
    try {
      plan = WikiRunPlanSchema.parse(body.plan);
    } catch (error) {
      sendError(
        res,
        400,
        "invalid plan",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
  }
  if (!plan) {
    sendError(res, 400, "no plan available to approve");
    return;
  }
  if (typeof body.notes === "string" && body.notes.trim()) {
    plan = { ...plan, notes: body.notes.trim() };
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      plan,
      summary: "Plan approved; write phase starting",
      error: null,
    });
    resumeRunInBackground(workspace, runId, "plan", "approve", plan);
    sendJson(res, 200, { run: updated });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

/** Automation HITL: deny plan. */
export async function handleDenyPlan(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const existing = await loadRun(workspace.rootPath, runId);
  if (!existing) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (existing.status !== "awaiting_plan") {
    sendError(res, 409, `run is not awaiting plan (status: ${existing.status})`);
    return;
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "cancelled",
      error: "plan declined",
      summary: "Plan declined by operator",
    });
    resumeRunInBackground(workspace, runId, "plan", "deny", existing.plan);
    emitRunDone(runId, "cancelled", "Plan declined by operator");
    sendJson(res, 200, { run: updated });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

/** Automation HITL: revise plan. */
export async function handleRevisePlan(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const existing = await loadRun(workspace.rootPath, runId);
  if (!existing) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (existing.status !== "awaiting_plan") {
    sendError(
      res,
      409,
      `run is not awaiting plan (status: ${existing.status})`,
    );
    return;
  }

  const body = (await readJsonBody(req)) as { feedback?: unknown };
  const feedback =
    typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (!feedback) {
    sendError(res, 400, "feedback is required to revise the plan");
    return;
  }
  if (feedback.length > 4000) {
    sendError(res, 400, "feedback must be at most 4000 characters");
    return;
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      summary: "Revising plan from operator feedback",
      error: null,
      plan: existing.plan ?? null,
    });
    resumeRunInBackground(
      workspace,
      runId,
      "plan",
      "revise",
      existing.plan,
      feedback,
    );
    sendJson(res, 200, { run: updated });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleListRuns(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  const runs = await listRuns(workspace.rootPath);
  sendJson(res, 200, { workspaceId: workspace.id, runs });
}

export async function handleGetRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  sendJson(res, 200, { run });
}

/** Automation HITL: approve publication. */
export async function handleApprovePublication(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (run.status !== "awaiting_publication") {
    sendError(
      res,
      409,
      `run is not awaiting publication (status: ${run.status})`,
    );
    return;
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      error: null,
      summary: "Publication approved; publishing…",
    });
    resumeRunInBackground(workspace, runId, "publication", "approve");
    sendJson(res, 200, {
      run: updated,
      publicationPath: workspace.publicationPath,
    });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

/** Automation HITL: deny publication. */
export async function handleDenyPublication(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (run.status !== "awaiting_publication") {
    sendError(
      res,
      409,
      `run is not awaiting publication (status: ${run.status})`,
    );
    return;
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      error: null,
      summary: "Publication declining…",
    });
    resumeRunInBackground(workspace, runId, "publication", "deny");
    sendJson(res, 200, { run: updated });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleCancelRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (
    run.status !== "running" &&
    run.status !== "awaiting_plan" &&
    run.status !== "awaiting_publication"
  ) {
    sendError(res, 409, `run is not cancellable (status: ${run.status})`);
    return;
  }

  abortRun(runId);
  emitRunEvent(runId, {
    type: "log",
    status: "running",
    message: "cancel requested",
  });

  let updated;
  try {
    updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "cancelled",
      error: "cancelled",
      summary: "Wiki Run cancelled",
    });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(
        res,
        409,
        `run is not running (status: ${error.record.status})`,
      );
      return;
    }
    throw error;
  }
  emitRunDone(runId, "cancelled", "Wiki Run cancelled");

  await cleanupSessionAfterCancel({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    runId,
    priorRunStatus: run.status,
    priorSummary: run.summary,
    sessionId: updated.sessionId,
  });

  sendJson(res, 200, { run: updated });
}

export async function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const writeEvent = (event: RunSseEvent): void => {
    if (res.writableEnded) {
      return;
    }
    res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  let recent = getRecentRunEvents(runId);

  if (isTerminalRunStatus(run.status) && recent.length === 0) {
    try {
      await replayWikiRunAuditEvents(runId, (jobEvent) => {
        if (jobEvent.type === "part") {
          emitRunEvent(runId, {
            type: "part",
            partType: jobEvent.partType,
            message: jobEvent.message,
            text: jobEvent.text,
            nodeId: jobEvent.nodeId,
          });
          return;
        }
        emitRunEvent(runId, {
          type: "log",
          message: jobEvent.message,
          nodeId: jobEvent.nodeId,
        });
      });
      recent = getRecentRunEvents(runId);
    } catch {
      // Best-effort
    }
  }

  for (const event of recent) {
    writeEvent(event);
  }

  if (isTerminalRunStatus(run.status)) {
    const snapshot: RunSseEvent = {
      type: "done",
      runId: run.runId,
      sequence: (recent[recent.length - 1]?.sequence ?? 0) + 1,
      status: run.status,
      message: run.error ?? run.summary ?? run.status,
    };
    writeEvent(snapshot);
    res.end();
    return;
  }

  if (recent.length === 0) {
    writeEvent({
      type: "status",
      runId: run.runId,
      sequence: 0,
      status: run.status,
      message: run.error ?? run.summary ?? run.status,
    });
  }

  let closed = false;
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      return;
    }
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  const lastReplayed = recent[recent.length - 1]?.sequence ?? -1;
  const unsubscribe = subscribeRunEvents(runId, (event) => {
    if (event.sequence <= lastReplayed) {
      return;
    }
    writeEvent(event);
    if (
      event.type === "done" ||
      (event.status && isTerminalRunStatus(event.status))
    ) {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    req.off("close", onClose);
  };

  const onClose = (): void => {
    cleanup();
  };
  req.on("close", onClose);

  const latest = await loadRun(workspace.rootPath, runId);
  if (latest && isTerminalRunStatus(latest.status) && !closed) {
    writeEvent({
      type: "done",
      runId: latest.runId,
      sequence: lastReplayed + 1,
      status: latest.status,
      message: latest.error ?? latest.summary ?? latest.status,
    });
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  }
}
