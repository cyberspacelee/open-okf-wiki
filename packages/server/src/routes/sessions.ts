/**
 * Operator Session HTTP routes — list/create/get/delete/reset meta only.
 *
 * Conversational chat (AI SDK UIMessage stream / Mastra SessionTurn) has been
 * removed. Clients should use Pi agent sessions:
 *   POST/GET /api/workspaces/:id/agent/sessions
 *   POST     /api/workspaces/:id/agent/sessions/:sessionId/command
 *   GET      /api/workspaces/:id/agent/sessions/:sessionId/events
 *
 * Headless Wiki Runs continue via /api/workspaces/:id/runs (wiki-run-job → Pi).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSession,
  loadWorkspaceById,
  resetOperatorSessionWorkflow,
  SessionSchemaVersionError,
} from "@okf-wiki/core";
import type { OperatorSession } from "@okf-wiki/contract";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { loadSessionReconciled } from "../session-load.ts";

// Re-export lock helpers for existing test imports (lock still useful for
// any future concurrent-turn guards; chat stream no longer uses it).
export {
  isSessionChatInFlightForTests,
  isSessionChatTurnBlocked,
  sessionChatLockKey,
  setSessionChatInFlightForTests,
} from "../session-chat-lock.ts";

export async function handleListSessions(
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
  let sessions: OperatorSession[];
  try {
    sessions = await listOperatorSessions(workspace.rootPath);
  } catch (error) {
    if (error instanceof SessionSchemaVersionError) {
      sendError(res, 410, error.message);
      return;
    }
    throw error;
  }
  sendJson(res, 200, {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      pending: s.pending,
      workflow: s.workflow,
    })),
  });
}

export async function handleCreateSession(
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
  const body = (await readJsonBody(req).catch(() => ({}))) as { title?: unknown };
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : `Wiki Session · ${workspace.name}`;
  const session = await createOperatorSession({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    title,
  });
  sendJson(res, 201, { session });
}

export async function handleGetSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  let session: OperatorSession | null;
  try {
    session = await loadSessionReconciled(workspace.rootPath, sessionId);
  } catch (error) {
    if (error instanceof SessionSchemaVersionError) {
      sendError(res, 410, error.message);
      return;
    }
    throw error;
  }
  if (!session || session.workspaceId !== workspace.id) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }
  sendJson(res, 200, { session });
}

export async function handleDeleteSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
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
  // Allow deleting unsupported-schema sessions (wipe recovery path).
  try {
    const existing = await loadOperatorSession(workspace.rootPath, sessionId);
    if (existing && existing.workspaceId !== workspace.id) {
      sendError(res, 404, `session not found: ${sessionId}`);
      return;
    }
  } catch (error) {
    if (!(error instanceof SessionSchemaVersionError)) {
      throw error;
    }
  }
  const ok = await deleteOperatorSession(workspace.rootPath, sessionId);
  if (!ok) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }
  sendJson(res, 200, { deleted: true, sessionId });
}

/** Clear pending gate / stuck phase so kickoff can run again. */
export async function handleResetSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
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
  const existing = await loadOperatorSession(workspace.rootPath, sessionId);
  if (!existing || existing.workspaceId !== workspace.id) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }
  try {
    const session = await resetOperatorSessionWorkflow(
      workspace.rootPath,
      sessionId,
    );
    sendJson(res, 200, { session });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("session not found")) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 400, message);
  }
}

/**
 * Legacy UIMessage chat endpoint — retired with AI SDK / Mastra SessionTurn.
 * Clients must use Pi agent sessions (ADR 0030).
 */
export async function handleSessionChat(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  _url: URL,
): Promise<void> {
  sendError(
    res,
    410,
    `session chat retired: use /api/workspaces/${id}/agent/sessions (session ${sessionId})`,
  );
}

/** Get or create the latest session for a workspace (v1 single default thread). */
export async function handleGetOrCreateSession(
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
  const existing = await listOperatorSessions(workspace.rootPath);
  if (existing.length > 0) {
    sendJson(res, 200, { session: existing[0], created: false });
    return;
  }
  // Allow POST body title
  let title: string | undefined;
  if (req.method === "POST") {
    const body = (await readJsonBody(req).catch(() => ({}))) as { title?: unknown };
    if (typeof body.title === "string") {
      title = body.title;
    }
  }
  const session = await createOperatorSession({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    title: title ?? `Wiki Session · ${workspace.name}`,
  });
  sendJson(res, 201, { session, created: true });
}
