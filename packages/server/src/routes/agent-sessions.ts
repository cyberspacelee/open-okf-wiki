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
import { isPathInside, loadRun, loadWorkspaceById } from "@okf-wiki/core";
import {
  agentSessionExistsOnDisk,
  dispatchAgentCommand,
  ensurePiSessionsDir,
  getRegisteredAgentSession,
  registerAgentSession,
} from "../agent-session-registry.ts";
import {
  getRecentAgentSessionEvents,
  subscribeAgentSessionEvents,
} from "../agent-session-events.ts";
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
  }>,
): PiSessionSummary[] {
  type Ranked = PiSessionSummary & { rank: number };
  const byId = new Map<string, Ranked>();

  for (const entry of entries) {
    const { name, isDirectory: isDir, updatedAt } = entry;
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
      updatedAt,
      placeholder: isMetaJson,
      rank,
    };

    const existing = byId.get(idFromName);
    if (!existing || candidate.rank > existing.rank) {
      byId.set(idFromName, candidate);
    } else if (
      candidate.rank === existing.rank &&
      (candidate.updatedAt ?? "") > (existing.updatedAt ?? "")
    ) {
      byId.set(idFromName, candidate);
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
  }> = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (!isPathInside(path.resolve(workspace.rootPath), full)) continue;
    try {
      const st = await stat(full);
      entries.push({
        name,
        isDirectory: st.isDirectory(),
        updatedAt: st.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }

  sendJson(res, 200, { sessions: mergePiSessionEntries(entries) });
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

  const history = await loadPiSessionHistory(workspace.rootPath, sessionId);
  const reg = getRegisteredAgentSession(workspace.id, sessionId);
  let runStatus: string | undefined;
  if (reg?.runId) {
    try {
      const run = await loadRun(workspace.rootPath, reg.runId);
      runStatus = run?.status;
    } catch {
      // ignore
    }
  }

  sendJson(res, 200, {
    session: {
      id: sessionId,
      workspaceId: workspace.id,
      title: reg?.title,
      sessionFile: history.sessionFile,
    },
    messages: history.messages,
    product: {
      runId: reg?.runId,
      runStatus,
      phase: reg?.shell?.phase,
      pendingGate: reg?.shell?.pendingGate
        ? {
            gate: reg.shell.pendingGate === "publish" ? "publication" : "plan",
            plan: reg.shell.plan,
            pages: reg.shell.pages,
          }
        : null,
      plan: reg?.shell?.plan ?? null,
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
