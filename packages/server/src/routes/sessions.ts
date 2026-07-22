/**
 * Operator Session HTTP routes.
 * Chat handler is a thin shell: parse → lock → SessionTurn → pipe → finalize.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createSessionTurnStream,
  projectSessionMessages,
  redactErrorMessage,
  sessionMessagesToUIMessages,
  uiMessagesToSessionMessages,
  type SessionStreamBody,
} from "@okf-wiki/agent";
import {
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSession,
  loadRun,
  loadWorkspaceById,
  neutralizeSessionDecisionParts,
  replaceSessionMessages,
  resetOperatorSessionWorkflow,
  SessionSchemaVersionError,
} from "@okf-wiki/core";
import {
  consumeStream,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
} from "ai";
import type { OperatorSession } from "@okf-wiki/contract";
import { helpTextForSessionTurn } from "@okf-wiki/contract";
import {
  BodyTooLargeError,
  InvalidJsonError,
  readJsonBody,
  sendError,
  sendJson,
} from "../http-util.ts";
import {
  clearRunAbortController,
  registerRunAbortController,
} from "../run-events.ts";
import {
  hasSessionChatLock,
  isSessionChatTurnBlocked,
  releaseSessionChatLock,
  sessionChatLockKey,
  setSessionChatInFlightForTests,
} from "../session-chat-lock.ts";
import { finalizeSessionChatTurn } from "../session-chat-finalize.ts";
import {
  eagerMidTurnPersist,
  eagerRegisterStartRun,
  markRunWorkflowLive,
} from "../session-chat-mid-turn.ts";
import { loadSessionReconciled } from "../session-load.ts";

// Re-export lock helpers for existing test imports.
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
 * AI SDK UI message stream for conversational Session.
 *
 * Body: { message (last user only), id?, intent?, resumeData?, runId?, step? }
 * Server loads prior session messages, appends the new user message, streams,
 * then onFinish saves the full UIMessage-compatible history.
 */
export async function handleSessionChat(
  req: IncomingMessage,
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
  // Reconcile with linked run first so refresh mid-write does not treat a
  // stale awaiting_plan phase as a live gate for resumeData reconstruction.
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

  let body: SessionStreamBody;
  try {
    body = (await readJsonBody(req)) as SessionStreamBody;
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      sendError(res, 400, "invalid JSON body");
      return;
    }
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, "request body too large");
      return;
    }
    throw error;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "chat body must be a JSON object");
    return;
  }

  // Server is source of truth: load history, append only body.message (last only).
  // projectSessionMessages once on load (session-messages is a structural bridge only).
  const previousUI = sessionMessagesToUIMessages(
    projectSessionMessages(session.messages),
  );
  let lastFromClient: UIMessage | undefined;
  if (body.message && typeof body.message === "object") {
    lastFromClient = body.message as UIMessage;
  }

  if (
    !lastFromClient ||
    typeof lastFromClient !== "object" ||
    lastFromClient.role !== "user"
  ) {
    sendError(
      res,
      400,
      "chat body must include a user message (body.message)",
    );
    return;
  }
  if (typeof lastFromClient.id !== "string" || !lastFromClient.id.trim()) {
    sendError(res, 400, "user message must include a non-empty id");
    return;
  }
  if (!Array.isArray(lastFromClient.parts)) {
    // Normalize missing parts so conversion never throws.
    lastFromClient = { ...lastFromClient, parts: [] };
  }

  // Dedup by id if client re-sent a message already persisted.
  const alreadyStored = previousUI.some((m) => m.id === lastFromClient!.id);
  if (alreadyStored) {
    // Idempotent retry: do not re-run the workflow turn.
    pipeUIMessageStreamToResponse({
      response: res,
      stream: createUIMessageStream({
        originalMessages: previousUI,
        execute: async () => {
          /* no-op — history already contains this user turn */
        },
      }),
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-transform",
      },
    });
    return;
  }

  // Refuse resume against a cancelled/terminal run (Stop-at-gate race or stale chips).
  // Structured resume only: intent=resume and/or resumeData (no free-text gate).
  const candidateRunId =
    (typeof body.runId === "string" && body.runId.trim()
      ? body.runId.trim()
      : undefined) ?? session.workflow?.linkedRunId;
  const lastText = (() => {
    for (const p of lastFromClient.parts ?? []) {
      if (
        p &&
        typeof p === "object" &&
        "type" in p &&
        (p as { type?: string }).type === "text" &&
        "text" in p &&
        typeof (p as { text?: unknown }).text === "string"
      ) {
        return (p as { text: string }).text.trim();
      }
    }
    return "";
  })();
  const looksLikeResume =
    body.intent === "resume" || Boolean(body.resumeData);
  if (looksLikeResume && candidateRunId) {
    const linkedRun = await loadRun(workspace.rootPath, candidateRunId);
    if (
      linkedRun &&
      linkedRun.status !== "awaiting_plan" &&
      linkedRun.status !== "awaiting_publication" &&
      linkedRun.status !== "running" &&
      linkedRun.status !== "needs_input"
    ) {
      // Reset session gate so the next turn can kick off cleanly.
      try {
        const cleaned = neutralizeSessionDecisionParts(session.messages);
        await replaceSessionMessages(
          workspace.rootPath,
          sessionId,
          cleaned,
          {
            status: "active",
            pending: null,
            workflow: {
              ...session.workflow,
              phase: "idle",
              linkedRunId: candidateRunId,
            },
          },
        );
      } catch {
        // best-effort
      }
      sendError(
        res,
        409,
        `cannot resume run (status: ${linkedRun.status}); start a new Wiki Run`,
      );
      return;
    }
  }

  // When answering a gate, drop prior actionable chips from the stream history so
  // onFinish / finalize cannot re-persist a stale plan card after approve.
  const historyForTurn = looksLikeResume
    ? sessionMessagesToUIMessages(
        projectSessionMessages(
          neutralizeSessionDecisionParts(session.messages),
        ),
      )
    : previousUI;
  const messages: UIMessage[] = [...historyForTurn, lastFromClient];

  // Concurrent turn lock:
  // 1) in-process Set — double-submit before eager persist
  // 2) durable session.status=running (TTL) — second request after restart/tab
  //    while a turn is mid-flight (refresh re-approve during write)
  const lockKey = sessionChatLockKey(workspace.rootPath, sessionId);
  const wouldRunWorkflow =
    body.intent === "start" ||
    body.intent === "resume" ||
    Boolean(body.resumeData);
  if (
    isSessionChatTurnBlocked({
      inFlight: hasSessionChatLock(lockKey),
      wouldRunWorkflow,
      session,
    })
  ) {
    const help = helpTextForSessionTurn({
      helpReason: "running",
      phase: session.workflow?.phase,
      userText: lastText,
    });
    pipeUIMessageStreamToResponse({
      response: res,
      stream: createUIMessageStream({
        originalMessages: previousUI,
        execute: async ({ writer }) => {
          const textId = `inflight-${Date.now()}`;
          writer.write({ type: "text-start", id: textId });
          writer.write({ type: "text-delta", id: textId, delta: help });
          writer.write({ type: "text-end", id: textId });
        },
      }),
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-transform",
      },
    });
    return;
  }
  setSessionChatInFlightForTests(lockKey, true);

  // Once the server drain task is scheduled, only finalizeOnce may release the lock.
  let serverDrainOwnsLock = false;
  // Track abort registration so setup failures before drain can clear the map.
  let registeredAbortRunId: string | undefined;
  /** Mid-stream checkpoints must stop once finalize owns the journal. */
  let allowCheckpoint = true;

  try {
    // abortSignalForRun registers AbortController when mode/runId are known
    // (sync, before stream execute) so Stop → abortRun can hard-stop mid-step.
    const chat = await createSessionTurnStream({
      session: {
        ...session,
        messages: uiMessagesToSessionMessages(messages),
      },
      workspace,
      messages,
      body,
      abortSignalForRun: (runId) => {
        registeredAbortRunId = runId;
        return registerRunAbortController(runId);
      },
      // Mark run running only once Mastra stream is open (crash-safe vs eager).
      onWorkflowLive: async (liveRunId) => {
        await markRunWorkflowLive({
          workspaceRoot: workspace.rootPath,
          sessionId,
          liveRunId,
        });
      },
      // Mid-stream journal so refresh mid-turn can render progress + keep catching up.
      onCheckpoint: async (snapshot) => {
        if (!allowCheckpoint) {
          return;
        }
        try {
          await replaceSessionMessages(
            workspace.rootPath,
            sessionId,
            snapshot.messages,
            {
              status: snapshot.status,
              pending: snapshot.pending,
              workflow: snapshot.workflow,
            },
          );
        } catch (error) {
          process.stderr.write(
            `session mid-stream checkpoint failed: ${redactErrorMessage(error)}\n`,
          );
        }
      },
    });

    // Eager run registry on start so explicit Session Stop → cancel can target
    // the job while the first stream is still open (before finalize upsert).
    if (chat.mode === "start" && chat.runId) {
      await eagerRegisterStartRun({
        workspace,
        sessionId,
        runId: chat.runId,
      });
    }

    // Eager gate-exit / mid-turn durability.
    if (chat.mode === "start" || chat.mode === "resume") {
      await eagerMidTurnPersist({
        workspace,
        session,
        sessionId,
        mode: chat.mode,
        runId: chat.runId,
        body,
        lastFromClient,
      });
    }

    let finalized = false;
    const finalizeOnce = async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      allowCheckpoint = false;
      try {
        await finalizeSessionChatTurn({
          workspaceRoot: workspace.rootPath,
          workspaceId: workspace.id,
          workspaceSkillPath: workspace.skillPath,
          sessionId,
          lastUserMessageId: lastFromClient.id,
          lastUserMessage: lastFromClient,
          chat,
          uiMessagesToSessionMessages,
        });
      } finally {
        releaseSessionChatLock(lockKey);
      }
    };

    // Disconnect durability (AI SDK consumeStream pattern):
    // tee the UI stream so the server fully drains one branch and always
    // finalizes/saves after execute + onFinish, even if the client aborts.
    // HTTP close cancels only the client tee branch (avoids backpressure stall)
    // and must NOT abort the underlying wiki run — explicit product cancel is
    // POST .../runs/:runId/cancel (Session Stop button calls that separately).
    const [clientStream, serverStream] = chat.stream.tee();

    serverDrainOwnsLock = true;
    void (async () => {
      try {
        await consumeStream({
          stream: serverStream,
          onError: (error) => {
            process.stderr.write(
              `session chat stream drain error: ${redactErrorMessage(error)}\n`,
            );
          },
        });
      } finally {
        // Drain completion means createUIMessageStream onFinish has run
        // (handleUIMessageStreamFinish flush), so finalize sees full messages.
        await finalizeOnce();
        if (chat.runId) {
          clearRunAbortController(chat.runId);
        }
      }
    })();

    const cancelClientBranch = () => {
      void clientStream.cancel().catch(() => undefined);
    };
    res.on("close", cancelClientBranch);

    pipeUIMessageStreamToResponse({
      response: res,
      stream: clientStream,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (error) {
    // Drain task (if started) finalizes, clears abort controller, and releases the lock.
    // If setup failed before drain ownership, release lock + abort map here.
    if (!serverDrainOwnsLock) {
      releaseSessionChatLock(lockKey);
      if (registeredAbortRunId) {
        clearRunAbortController(registeredAbortRunId);
      }
    }
    if (!res.headersSent) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "session chat failed",
      );
    }
  }
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
