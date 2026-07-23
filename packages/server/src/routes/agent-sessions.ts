/**
 * Pi agent session HTTP routes (ADR 0030).
 *
 * Primary conversational entry (ADR 0030). Legacy `/sessions` chat is retired.
 * Commands dispatch through agent-session-registry → @okf-wiki/agent
 * (createWikiSession, WikiRunShell via startWikiRun / resumeWikiRun).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadPiSessionHistory, piSessionsDir } from "@okf-wiki/agent";
import {
  CreatePiAgentSessionBodySchema,
  safeParseAgentCommand,
  type AgentSseEvent,
  type PiSessionSummary,
} from "@okf-wiki/contract";
import {
  isPathInside,
  loadRun,
  loadWorkspaceById,
} from "@okf-wiki/core";
import {
  agentSessionExistsOnDisk,
  deleteAgentSession,
  dispatchAgentCommand,
  ensurePiSessionsDir,
  ensureRegistered,
  foldWorkUnits,
  getRegisteredAgentSession,
  lastGateFromTrajectory,
  lastLinkedRunId,
  lastPlanFromTrajectory,
  lastRunPhase,
  loadTrajectory,
  registerAgentSession,
  resolveColdLoadPhase,
  resolveSessionHistoryFile,
} from "../agent-session-registry.ts";
import {
  getRecentAgentSessionEvents,
  subscribeAgentSessionEvents,
} from "../agent-session-events.ts";
import { readSessionMeta } from "../session/parent-session.ts";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";

const HEARTBEAT_MS = 15_000;

/**
 * Merge raw pi-sessions directory entries into unique product session summaries.
 * Prefer product meta `{id}.json` over companion workdir `{id}/`.
 * Standalone Pi `*.jsonl` files are conversation storage and are omitted.
 */
export function mergePiSessionEntries(
  entries: Array<{
    name: string;
    isDirectory: boolean;
    updatedAt?: string;
    /** Operator title from product meta (when known). */
    title?: string;
  }>,
): PiSessionSummary[] {
  type Ranked = PiSessionSummary & { rank: number };
  const byId = new Map<string, Ranked>();

  for (const entry of entries) {
    const { name, isDirectory: isDir, updatedAt, title } = entry;
    if (name.startsWith(".")) continue;

    const isJsonl = /\.jsonl$/i.test(name);
    if (isJsonl) continue;

    const isMetaJson = /\.json$/i.test(name);
    if (!isMetaJson && !isDir) continue;

    const idFromName = isDir ? name : name.replace(/\.json$/i, "");
    if (!idFromName) continue;

    const rank = isMetaJson ? 2 : 1;
    const candidate: Ranked = {
      id: idFromName,
      name,
      title,
      updatedAt,
      placeholder: isMetaJson,
      rank,
    };

    const existing = byId.get(idFromName);
    if (!existing || candidate.rank > existing.rank) {
      // Prefer higher-rank entry; keep title from either side.
      byId.set(idFromName, {
        ...candidate,
        title: candidate.title ?? existing?.title,
      });
    } else if (
      candidate.rank === existing.rank &&
      (candidate.updatedAt ?? "") > (existing.updatedAt ?? "")
    ) {
      byId.set(idFromName, {
        ...candidate,
        title: candidate.title ?? existing.title,
      });
    } else if (!existing.title && title) {
      byId.set(idFromName, { ...existing, title });
    }
  }

  return [...byId.values()]
    .map(({ rank: _rank, ...summary }) => summary)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

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

/**
 * GET /api/workspaces/:id/agent/sessions?rootPath=...
 * Lists entries under `.okf-wiki/pi-sessions/`.
 */
export async function handleListAgentSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const dir = await ensurePiSessionsDir(workspace.rootPath);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    // Missing or unreadable dir → empty list (ensurePiSessionsDir should create it).
  }

  const entries: Array<{
    name: string;
    isDirectory: boolean;
    updatedAt?: string;
    title?: string;
  }> = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (!isPathInside(path.resolve(workspace.rootPath), full)) continue;
    try {
      const st = await stat(full);
      let title: string | undefined;
      // Product meta `{id}.json` carries the operator title.
      if (/\.json$/i.test(name) && !st.isDirectory()) {
        const meta = await readSessionMeta(full);
        if (meta?.title?.trim()) title = meta.title.trim();
      }
      // Live registry may have a fresher auto-title than disk after first prompt.
      if (/\.json$/i.test(name)) {
        const idFromName = name.replace(/\.json$/i, "");
        const live = getRegisteredAgentSession(workspace.id, idFromName);
        if (live?.title?.trim()) title = live.title.trim();
      }
      entries.push({
        name,
        isDirectory: st.isDirectory(),
        updatedAt: st.mtime.toISOString(),
        title,
      });
    } catch {
      continue;
    }
  }

  sendJson(res, 200, { sessions: mergePiSessionEntries(entries) });
}

/**
 * DELETE /api/workspaces/:id/agent/sessions/:sessionId?rootPath=...
 * Removes product meta + workdir + Pi JSONL (pi-web SessionListDialog pattern).
 */
export async function handleDeleteAgentSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const exists = await agentSessionExistsOnDisk(workspace.rootPath, sessionId);
  if (!exists) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    return;
  }

  try {
    const result = await deleteAgentSession(workspace, sessionId);
    sendJson(res, 200, {
      ok: true,
      sessionId: result.sessionId,
      removed: result.removed.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, message);
  }
}

/**
 * POST /api/workspaces/:id/agent/sessions?rootPath=...
 * Creates session meta under pi-sessions and registers an in-memory entry.
 */
export async function handleCreateAgentSession(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const raw = await readJsonBody(req).catch(() => ({}));
  const parsed = CreatePiAgentSessionBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendError(res, 400, "invalid create session body", parsed.error.flatten());
    return;
  }

  try {
    const entry = await registerAgentSession({
      workspace,
      sessionId: parsed.data.sessionId,
      title: parsed.data.title,
    });

    sendJson(res, 201, {
      session: {
        id: entry.sessionId,
        workspaceId: workspace.id,
        title: entry.title,
        path: entry.metaPath,
        createdAt: entry.createdAt,
        /** Live AgentSession is constructed lazily on first prompt. */
        stub: false,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("sessionId must be alphanumeric")) {
      sendError(res, 400, message);
      return;
    }
    if (message.includes("escapes workspace")) {
      sendError(res, 400, message);
      return;
    }
    sendError(res, 500, message);
  }
}

/**
 * GET /api/workspaces/:id/agent/sessions/:sessionId?rootPath=...
 * Cold-load Pi JSONL history + product meta (pi-web style reload).
 */
export async function handleGetAgentSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const exists = await agentSessionExistsOnDisk(workspace.rootPath, sessionId);
  if (!exists) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    return;
  }

  // Ensure registry entry exists so re-entry after process restart can rehydrate
  // runId / shell from durable trajectory + Run Record (not only live memory).
  let reg = getRegisteredAgentSession(workspace.id, sessionId);
  if (!reg) {
    try {
      reg = await ensureRegistered(workspace, sessionId);
    } catch {
      reg = undefined;
    }
  }

  // Prefer live / meta sessionFile so cold history matches the JSONL Pi writes
  // (`{timestamp}_{id}.jsonl`, not `{id}.jsonl` — see pi-web SessionManager).
  const preferredPath = await resolveSessionHistoryFile(
    workspace.rootPath,
    sessionId,
    reg,
  );
  const history = await loadPiSessionHistory(workspace.rootPath, sessionId, {
    preferredPath,
  });

  // Cold-load product trajectory (work_unit fold + last run_phase / plan / runId).
  const trajectory = await loadTrajectory(workspace.rootPath, sessionId);
  const workUnits = [...foldWorkUnits(trajectory).values()];
  const trajRunId = lastLinkedRunId(trajectory);
  const runId = reg?.runId ?? trajRunId;
  const trajPlan = lastPlanFromTrajectory(trajectory);
  const trajGate = lastGateFromTrajectory(trajectory);
  const productPhase = resolveColdLoadPhase({
    shellPhase: reg?.shell?.phase,
    lastPhaseFromTrajectory: lastRunPhase(trajectory),
  });

  let runStatus: string | undefined;
  let plan = reg?.shell?.plan ?? trajPlan ?? null;
  let runPages: string[] | undefined =
    reg?.shell?.pages ?? trajGate?.pages ?? undefined;

  if (runId) {
    try {
      const run = await loadRun(workspace.rootPath, runId);
      if (run) {
        runStatus = run.status;
        if (!plan && run.plan) plan = run.plan;
        if ((!runPages || runPages.length === 0) && run.pages?.length) {
          runPages = run.pages;
        }
      }
    } catch {
      // ignore
    }
  }

  // Rehydrate in-memory registry so subsequent commands (resume / abort) see
  // the linked run after a cold re-entry.
  if (reg) {
    if (!reg.runId && runId) reg.runId = runId;
    if (plan && !reg.shell?.plan) {
      reg.shell = {
        phase:
          productPhase === "awaiting_plan"
            ? "awaiting_plan"
            : productPhase === "awaiting_publish"
              ? "awaiting_publish"
              : productPhase === "writing" || productPhase === "planning"
                ? "producing"
                : productPhase === "failed"
                  ? "failed"
                  : productPhase === "cancelled"
                    ? "cancelled"
                    : productPhase === "done"
                      ? "published"
                      : "idle",
        plan,
        pages: runPages,
        pendingGate:
          productPhase === "awaiting_plan"
            ? "plan"
            : productPhase === "awaiting_publish"
              ? "publish"
              : undefined,
        summary: plan.summary,
      };
    }
  }

  const pendingGateFromShell = reg?.shell?.pendingGate
    ? {
        gate:
          reg.shell.pendingGate === "publish" ? "publication" : ("plan" as const),
        plan: reg.shell.plan ?? plan ?? undefined,
        pages: reg.shell.pages ?? runPages,
      }
    : null;

  const pendingGateFromDurable =
    !pendingGateFromShell &&
    (productPhase === "awaiting_plan" || productPhase === "awaiting_publish") &&
    trajGate
      ? {
          gate: trajGate.gate,
          plan: trajGate.plan ?? plan ?? undefined,
          pages: trajGate.pages ?? runPages,
        }
      : productPhase === "awaiting_plan" || productPhase === "awaiting_publish"
        ? {
            gate:
              productPhase === "awaiting_plan"
                ? ("plan" as const)
                : ("publication" as const),
            plan: plan ?? undefined,
            pages: runPages,
          }
        : null;

  sendJson(res, 200, {
    session: {
      id: sessionId,
      workspaceId: workspace.id,
      title: reg?.title,
      sessionFile: history.sessionFile,
    },
    messages: history.messages,
    product: {
      runId,
      runStatus,
      phase: productPhase,
      busy: reg?.busy === true,
      pendingGate: pendingGateFromShell ?? pendingGateFromDurable,
      plan,
      workUnits,
      /** Full product inject history for cold project (optional for clients). */
      trajectory,
    },
  });
}

/**
 * POST /api/workspaces/:id/agent/sessions/:sessionId/command?rootPath=...
 * Validates AgentCommand and dispatches via agent-session-registry.
 */
export async function handleAgentSessionCommand(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const exists = await agentSessionExistsOnDisk(workspace.rootPath, sessionId);
  if (!exists) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    return;
  }

  const body = await readJsonBody(req);
  const parsed = safeParseAgentCommand(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid agent command", parsed.error.flatten());
    return;
  }

  try {
    const response = await dispatchAgentCommand(
      workspace,
      sessionId,
      parsed.data,
    );
    sendJson(res, 202, response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found")) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 500, message);
  }
}

/**
 * GET /api/workspaces/:id/agent/sessions/:sessionId/events?rootPath=...
 * SSE stream: recent bus events + heartbeats + live Pi/product injects.
 */
export async function handleAgentSessionEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const writeEvent = (event: AgentSseEvent): void => {
    if (res.writableEnded) return;
    const seq =
      "sequence" in event && typeof event.sequence === "number"
        ? event.sequence
        : Date.now();
    res.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of getRecentAgentSessionEvents(workspace.id, sessionId)) {
    writeEvent(event);
  }

  // Initial hello so clients know the stream is live even with empty history.
  writeEvent({
    source: "server",
    kind: "heartbeat",
    sessionId,
    timestamp: new Date().toISOString(),
  });

  const unsubscribe = subscribeAgentSessionEvents(
    workspace.id,
    sessionId,
    writeEvent,
  );

  const heartbeat = setInterval(() => {
    writeEvent({
      source: "server",
      kind: "heartbeat",
      sessionId,
      timestamp: new Date().toISOString(),
    });
  }, HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) {
      res.end();
    }
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
}

// Re-export for tests / diagnostics.
export { piSessionsDir };
