/** Thin HTTP adapter over Pi-native Operator Sessions (ADR 0032). */

import type { IncomingMessage, ServerResponse } from "node:http";
import { listOperatorSessions } from "@okf-wiki/agent";
import {
  type AgentSseEvent,
  type AgentSseSnapshot,
  CreatePiAgentSessionBodySchema,
  safeParseAgentCommand,
} from "@okf-wiki/contract";
import { loadWorkspaceById } from "@okf-wiki/core";
import { subscribeAgentSessionEvents } from "../agent-session-events.ts";
import {
  agentSessionExists,
  deleteAgentSession,
  dispatchAgentCommand,
  getActiveAgentSessionTool,
  getLiveAgentSessionSummary,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
  registerAgentSession,
} from "../agent-session-registry.ts";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";

const HEARTBEAT_MS = 15_000;

export type AgentSessionSseDependencies = {
  getActiveTool?: typeof getActiveAgentSessionTool;
  loadHistory?: typeof loadAgentSessionHistory;
  subscribe?: typeof subscribeAgentSessionEvents;
  heartbeatMs?: number;
};

async function loadWorkspaceOr404(res: ServerResponse, id: string, url: URL) {
  const workspace = await loadWorkspaceById(id, {
    rootPath: url.searchParams.get("rootPath") ?? undefined,
  });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return null;
  }
  return workspace;
}

/** GET SessionManager's workspace-scoped index. */
export async function handleListAgentSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  const sessionsById = new Map(
    (await listOperatorSessions(workspace.rootPath)).map(
      (summary) => [summary.id, summary] as const,
    ),
  );
  for (const live of listLiveAgentSessionSummaries(workspace.id)) {
    sessionsById.set(live.id, live);
  }
  const sessions = [...sessionsById.values()].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  sendJson(res, 200, { sessions });
}

/** POST creates a real live SessionManager; Pi persists it on the first completed turn. */
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
    const session = await registerAgentSession({
      workspace,
      sessionId: parsed.data.sessionId,
      title: parsed.data.title,
    });
    sendJson(res, 201, {
      session: {
        id: session.id,
        workspaceId: workspace.id,
        title: session.title ?? `Wiki Agent · ${workspace.name}`,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already exists")) {
      sendError(res, 409, message);
      return;
    }
    if (/session.*id|invalid/i.test(message)) {
      sendError(res, 400, message);
      return;
    }
    sendError(res, 500, message);
  }
}

/** GET reads the exact active SessionManager branch; no product metadata merge. */
export async function handleGetAgentSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  const info = (await listOperatorSessions(workspace.rootPath)).find(
    (session) => session.id === sessionId,
  );
  const live = getLiveAgentSessionSummary(workspace.id, sessionId);
  if (!info && !live) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    return;
  }
  const history = await loadAgentSessionHistory(workspace, sessionId);
  if (!history) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    return;
  }
  sendJson(res, 200, {
    session: {
      id: info?.id ?? history.sessionId,
      workspaceId: workspace.id,
      title: info?.title ?? live?.title,
      createdAt: info?.createdAt ?? live?.createdAt,
      updatedAt: info?.updatedAt ?? live?.updatedAt,
    },
    messages: history.messages,
  });
}

/** DELETE Session JSONL and all associated v2 Run data. */
export async function handleDeleteAgentSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  if (!(await agentSessionExists(workspace, sessionId))) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    return;
  }
  try {
    const deleted = await deleteAgentSession(workspace, sessionId);
    sendJson(res, 200, {
      ok: true,
      sessionId: deleted.sessionId,
      removed: deleted.removed,
    });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/** POST delegates to AgentSession prompt/steer/abort/compact or the active tool gate. */
export async function handleAgentSessionCommand(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  if (!(await agentSessionExists(workspace, sessionId))) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    return;
  }

  const parsed = safeParseAgentCommand(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid agent command", parsed.error.flatten());
    return;
  }
  try {
    sendJson(res, 202, await dispatchAgentCommand(workspace, sessionId, parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, message.includes("not found") ? 404 : 500, message);
  }
}

/** SSE: one current SessionManager snapshot, then genuine Pi events and heartbeats. */
export async function handleAgentSessionEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
  dependencies: AgentSessionSseDependencies = {},
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  let closed = false;
  let ready = false;
  const lifecycle: { heartbeat?: ReturnType<typeof setInterval> } = {};
  let unsubscribe = (): void => undefined;
  const pending: AgentSseEvent[] = [];

  function onRequestClose(): void {
    // IncomingMessage also emits close after a normally completed GET. The
    // response close event owns that normal lifecycle; only an incomplete or
    // aborted request is itself a disconnect signal.
    if (req.aborted || !req.complete) cleanup();
  }
  function cleanup(): void {
    if (closed) return;
    closed = true;
    ready = false;
    pending.length = 0;
    if (lifecycle.heartbeat) clearInterval(lifecycle.heartbeat);
    unsubscribe();
    req.off("close", onRequestClose);
    res.off("close", cleanup);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
  const writeEvent = (event: AgentSseEvent): void => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      cleanup();
    }
  };
  unsubscribe = (dependencies.subscribe ?? subscribeAgentSessionEvents)(
    workspace.id,
    sessionId,
    (event) => {
      if (ready) writeEvent(event);
      else pending.push(event);
    },
  );
  // This is the snapshot/live cut. The active tool is captured immediately
  // after subscription; any later Pi update is already queued in `pending`
  // and must be applied after this snapshot, never folded backward into it.
  const activeTool = (dependencies.getActiveTool ?? getActiveAgentSessionTool)(
    workspace.id,
    sessionId,
  );
  req.once("close", onRequestClose);
  res.once("close", cleanup);

  let history: Awaited<ReturnType<typeof loadAgentSessionHistory>>;
  try {
    history = await (dependencies.loadHistory ?? loadAgentSessionHistory)(workspace, sessionId);
  } catch (error) {
    if (closed) return;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
    cleanup();
    return;
  }
  if (closed) return;
  if (!history) {
    sendError(res, 404, `agent session not found: ${sessionId}`);
    cleanup();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeEvent({
    source: "server",
    kind: "snapshot",
    sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      session: { id: sessionId, workspaceId: workspace.id },
      messages: history.messages,
      ...(activeTool ? { activeTool } : {}),
    },
  } satisfies AgentSseSnapshot);
  ready = true;
  for (const event of pending.splice(0)) writeEvent(event);
  if (closed) return;

  lifecycle.heartbeat = setInterval(() => {
    writeEvent({
      source: "server",
      kind: "heartbeat",
      sessionId,
      timestamp: new Date().toISOString(),
    });
  }, dependencies.heartbeatMs ?? HEARTBEAT_MS);
}
