import type { IncomingMessage, ServerResponse } from "node:http";
import {
  redactErrorMessage,
  resolveSkillPath,
  resumeWikiRun,
  startWikiRun,
} from "@okf-wiki/agent";
import {
  appendSessionMessages,
  createOperatorSession,
  listOperatorSessions,
  loadWorkspaceById,
  probeLocalGit,
  replaceSessionMessages,
  skillDigest,
  loadOperatorSession,
  neutralizeSessionDecisionParts,
} from "@okf-wiki/core";
import {
  isTerminalRunStatus,
  WikiRunPlanSchema,
  type OperatorSession,
  type SessionWorkflowState,
  type WikiRunPlan,
  type WikiRunRecordStatus,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { randomUUID } from "node:crypto";
import type { RunSseEvent } from "@okf-wiki/contract";
import {
  readJsonBody,
  sendError,
  sendJson,
} from "../http-util.ts";
import {
  abortRun,
  clearRunAbortController,
  emitRunDone,
  emitRunEvent,
  emitRunStatus,
  registerRunAbortController,
  getRecentRunEvents,
  subscribeRunEvents,
} from "../run-events.ts";
import {
  createRun,
  listRuns,
  loadRun,
  RunStatusConflictError,
  updateRunRecord,
} from "../run-registry.ts";

/** Map run status → Session workflow phase (ADR 0026 observe path). */
function sessionPhaseForRunStatus(
  status: WikiRunRecordStatus,
): SessionWorkflowState["phase"] {
  switch (status) {
    case "awaiting_plan":
      return "awaiting_plan";
    case "awaiting_publication":
      return "awaiting_publish";
    case "published":
    case "publication_declined":
      return "done";
    case "running":
      return "writing";
    case "cancelled":
    case "failed":
    default:
      return "idle";
  }
}

/**
 * Append a high-level trajectory message to the Session linked to this run.
 * Background/headless jobs must still appear on Session (ADR 0026 I3).
 */
export async function projectRunStatusToSession(
  rootPath: string,
  runId: string,
  patch: {
    status: WikiRunRecordStatus;
    summary?: string | null;
    plan?: WikiRunPlan | null;
    pages?: string[] | null;
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

  const phase = sessionPhaseForRunStatus(patch.status);
  const summary =
    patch.summary?.trim() ||
    run?.summary?.trim() ||
    `Wiki Run ${patch.status}`;
  const plan = patch.plan ?? run?.plan ?? session.workflow?.plan;
  const pages = patch.pages ?? run?.pages ?? undefined;

  const parts: OperatorSession["messages"][number]["parts"] = [
    {
      type: "data-run",
      id: randomUUID(),
      data: { runId, status: patch.status },
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

  const pending =
    patch.status === "awaiting_plan" || patch.status === "awaiting_publication"
      ? session.pending
      : null;

  try {
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
        status:
          patch.status === "awaiting_plan" ||
          patch.status === "awaiting_publication"
            ? "waiting"
            : patch.status === "running"
              ? "running"
              : patch.status === "published" ||
                  patch.status === "publication_declined"
                ? "completed"
                : patch.status === "failed"
                  ? "failed"
                  : "active",
        pending:
          patch.status === "awaiting_plan" ||
          patch.status === "awaiting_publication"
            ? pending
            : null,
        workflow: {
          ...session.workflow,
          linkedRunId: runId,
          phase,
          ...(plan ? { plan } : {}),
        },
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
  if (existing?.status === "cancelled" && patch.status !== "cancelled") {
    // Cancel already recorded — keep it and ensure stream is closed.
    emitRunDone(runId, "cancelled", existing.summary ?? "Wiki Run cancelled");
    return;
  }

  const updated = await updateRunRecord(rootPath, runId, {
    status: patch.status,
    error: patch.error,
    pages: patch.pages,
    summary: patch.summary,
    ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
  });

  // TOCTOU: cancel may have landed between load and write; registry returns the
  // cancelled record unchanged when a non-cancel patch loses the race.
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

  // ADR 0026 I3: background trajectory still lands on the linked Session.
  await projectRunStatusToSession(rootPath, runId, {
    status: updated.status,
    summary: updated.summary ?? patch.summary,
    plan: patch.plan ?? updated.plan,
    pages: patch.pages ?? updated.pages,
  });
}

type ProcessRunOptions = {
  autoApprove?: boolean;
  phase?: "plan" | "write";
  plan?: WikiRunPlan;
};

/**
 * Background Wiki Run via Mastra wiki-run workflow (single production path).
 * Plan/write/publish gates live in the workflow; autoApprove skips suspends.
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
        onEvent: (event) => {
          if (event.type === "part") {
            emitRunEvent(runId, {
              type: "part",
              partType: event.partType,
              message: event.message,
              text: event.text,
              nodeId: event.nodeId,
            });
            return;
          }
          emitRunEvent(runId, {
            type: "log",
            message: event.message,
            nodeId: event.nodeId,
          });
        },
      });

      // Late abort must not rewrite durable publish outcomes.
      const durableSuccess =
        result.status === "published" ||
        result.status === "publication_declined";
      if (
        result.status === "cancelled" ||
        (abortSignal.aborted && !durableSuccess)
      ) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          pages: result.pages ?? null,
          summary: result.summary ?? "Wiki Run cancelled",
        });
        return;
      }

      if (result.status === "awaiting_plan") {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "awaiting_plan",
          error: null,
          pages: result.pages ?? null,
          summary: result.summary ?? "Awaiting plan confirmation",
          plan: result.plan ?? null,
        });
        emitRunEvent(runId, {
          type: "part",
          partType: "data-plan",
          message: result.plan?.summary ?? "plan ready",
          text: result.plan ? JSON.stringify(result.plan) : undefined,
        });
        return;
      }

      emitRunEvent(runId, {
        type: "log",
        message: result.summary ?? `workflow finished: ${result.status}`,
      });
      await finalizeRunStatus(workspace.rootPath, runId, {
        status: result.status,
        error: result.error ?? null,
        pages: result.pages ?? null,
        summary: result.summary ?? null,
        ...(result.plan ? { plan: result.plan } : {}),
      });
    } catch (error) {
      process.stderr.write(`run ${runId} failed: ${redactErrorMessage(error)}\n`);
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
 * Resume a suspended wiki-run workflow (plan or publication) and persist status.
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

      const result = await resumeWikiRun({
        runId,
        gate,
        action,
        plan,
        feedback,
        abortSignal,
        onEvent: (event) => {
          emitRunEvent(runId, {
            type: "log",
            message: event.message,
            nodeId: event.nodeId,
          });
        },
      });

      // Late abort must not rewrite durable publish outcomes.
      const durableSuccess =
        result.status === "published" ||
        result.status === "publication_declined";
      if (
        result.status === "cancelled" ||
        (abortSignal.aborted && !durableSuccess)
      ) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          pages: result.pages ?? null,
          summary: result.summary ?? "Wiki Run cancelled",
        });
        return;
      }

      if (result.status === "awaiting_plan") {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "awaiting_plan",
          error: null,
          plan: result.plan ?? plan ?? null,
          summary: result.summary ?? "Awaiting plan confirmation",
        });
        return;
      }

      if (result.status === "awaiting_publication") {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "awaiting_publication",
          error: null,
          pages: result.pages ?? null,
          summary: result.summary ?? "Awaiting publication approval",
          plan: result.plan ?? plan ?? null,
        });
        return;
      }

      await finalizeRunStatus(workspace.rootPath, runId, {
        status: result.status,
        error: result.error ?? null,
        pages: result.pages ?? null,
        summary: result.summary ?? null,
        ...(result.plan || plan ? { plan: result.plan ?? plan ?? null } : {}),
      });
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


export async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  if (!workspace.sources || workspace.sources.length === 0) {
    sendError(res, 400, "workspace must have at least one source before starting a run");
    return;
  }

  // Dirty-tree gate: every source must be a clean git working tree before a run.
  for (const source of workspace.sources) {
    const probe = await probeLocalGit(source.path);
    if (!probe.isGit) {
      sendError(
        res,
        400,
        `source "${source.id}" is not a git working tree: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
    if (probe.dirty) {
      sendError(
        res,
        400,
        `source "${source.id}" has a dirty git working tree; commit or stash before starting a run: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
  }

  const body = (await readJsonBody(req)) as { autoApprove?: unknown };
  const autoApprove =
    typeof body.autoApprove === "boolean" ? body.autoApprove : undefined;

  // Freeze Producer Skill path + content digest for this run (Manual Retry input).
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

  // Bind headless job to a Session so trajectory is observable (ADR 0026).
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

/**
 * Manual Retry: new Wiki Run reusing the earlier run's frozen skill path/digest
 * (and autoApprove). Does not resume Semantic Workflow history.
 */
export async function handleRetryRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  if (!workspace.sources || workspace.sources.length === 0) {
    sendError(res, 400, "workspace must have at least one source before retrying a run");
    return;
  }

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

  // Dirty-tree gate (same as create).
  for (const source of workspace.sources) {
    const probe = await probeLocalGit(source.path);
    if (!probe.isGit) {
      sendError(
        res,
        400,
        `source "${source.id}" is not a git working tree: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
    if (probe.dirty) {
      sendError(
        res,
        400,
        `source "${source.id}" has a dirty git working tree; commit or stash before retry: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
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
      // Verify frozen path still has SKILL.md; digest is trusted from record.
      await resolveSkillPath({ skillPath: frozenSkillPath });
    }
  } catch (error) {
    sendError(
      res,
      400,
      error instanceof Error ? error.message : "failed to resolve frozen skill for retry",
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

/**
 * HITL: approve a proposed plan and continue the write phase.
 * Headless/autoApprove never lands in awaiting_plan.
 */
export async function handleApprovePlan(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

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
    // Resume the suspended Mastra workflow plan-gate (same runId).
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

/** HITL: decline plan — cancel the run without writing wiki pages. */
export async function handleDenyPlan(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

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
    // Best-effort: close suspended workflow snapshot (bail path).
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

/**
 * HITL: revise plan with free-text feedback, re-run plan phase, re-suspend.
 * Run stays linked to the same Mastra runId (not a Manual Retry).
 */
export async function handleRevisePlan(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, {
    rootPath: rootPath ?? undefined,
  });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

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
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

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
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  sendJson(res, 200, { run });
}

/**
 * HITL: approve publication of a run that is awaiting_publication.
 * Copies staging → publicationPath and marks the run published.
 */
export async function handleApprovePublication(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

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
    const message = redactErrorMessage(error);
    emitRunEvent(runId, {
      type: "error",
      status: "awaiting_publication",
      message: `publication failed: ${message}`,
    });
    sendError(res, 500, `publication failed: ${message}`);
  }
}

/**
 * HITL: decline publication. Staging is retained; run becomes publication_declined.
 */
export async function handleDenyPublication(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

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

/**
 * Cancel a run that is still `running` or suspended on operator HITL
 * (`awaiting_plan` / `awaiting_publication`).
 * Best-effort: aborts the agent signal, marks the record cancelled, and
 * resets any linked Operator Session so Stop at a gate does not leave
 * durable approve/deny chips for a cancelled run.
 */
export async function handleCancelRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

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
    // Agent finalized between our status check and write — surface current state.
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

  // Session-first: cancel after a stream has already finalized at a gate must
  // still clear durable HITL so refresh does not re-offer approve/deny.
  // Mid-stream cancel also races finalizeOnce; neutralize is idempotent.
  // Do not clobber a concurrent finalize that already persisted a durable
  // publish outcome (phase done / completed) while cancel won the run record.
  const linkedSessionId = updated.sessionId;
  if (linkedSessionId) {
    try {
      const linked = await loadOperatorSession(
        workspace.rootPath,
        linkedSessionId,
      );
      const phase = linked?.workflow?.phase;
      const durableSessionDone =
        phase === "done" || linked?.status === "completed";
      if (
        linked &&
        linked.workspaceId === workspace.id &&
        !durableSessionDone &&
        (linked.workflow?.linkedRunId === runId ||
          !linked.workflow?.linkedRunId)
      ) {
        const messages = neutralizeSessionDecisionParts(linked.messages);
        await replaceSessionMessages(
          workspace.rootPath,
          linkedSessionId,
          messages,
          {
            status: "active",
            pending: null,
            workflow: {
              ...linked.workflow,
              phase: "idle",
              linkedRunId: runId,
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

  sendJson(res, 200, { run: updated });
}


export async function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }

  // SSE headers (CORS already applied by dispatch).
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

  // Replay buffered stream parts so late subscribers still see text/tools
  // (fixture runs often finish before EventSource connects).
  const recent = getRecentRunEvents(runId);
  for (const event of recent) {
    writeEvent(event);
  }

  // Terminal snapshot last when the run already finished.
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

  // Live run: status snapshot if buffer was empty.
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
    // SSE comment heartbeat keeps intermediaries from closing idle streams.
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  // Skip replaying sequences already sent from the ring buffer.
  const lastReplayed = recent[recent.length - 1]?.sequence ?? -1;
  const unsubscribe = subscribeRunEvents(runId, (event) => {
    if (event.sequence <= lastReplayed) {
      return;
    }
    writeEvent(event);
    if (event.type === "done" || (event.status && isTerminalRunStatus(event.status))) {
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

  // Re-check status in case the run finished between load and subscribe.
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
