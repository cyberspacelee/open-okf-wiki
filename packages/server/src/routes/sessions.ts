import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  createSessionWorkflowStream,
  redactErrorMessage,
  resolveSkillPath,
  sessionMessagesToUIMessages,
  uiMessagesToSessionMessages,
  type SessionStreamBody,
} from "@okf-wiki/agent";
import {
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSession,
  loadWorkspaceById,
  replaceSessionMessages,
  resetOperatorSessionWorkflow,
  skillDigest,
} from "@okf-wiki/core";
import {
  consumeStream,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
} from "ai";
import type { WikiRunRecordStatus } from "@okf-wiki/contract";
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
  loadRun,
  registerRunRecord,
  updateRunRecord,
} from "../run-registry.ts";

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
  const sessions = await listOperatorSessions(workspace.rootPath);
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
  const session = await loadOperatorSession(workspace.rootPath, sessionId);
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
  const existing = await loadOperatorSession(workspace.rootPath, sessionId);
  if (!existing || existing.workspaceId !== workspace.id) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
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
 * In-process lock so rapid double-submit cannot start two Wiki Runs before
 * the first turn finalizes session messages. Keyed by workspace root + session.
 */
const sessionChatInFlight = new Set<string>();

export function sessionChatLockKey(rootPath: string, sessionId: string): string {
  return `${path.resolve(rootPath)}::${sessionId}`;
}

/**
 * After product cancel, strip actionable HITL chips from durable history so a
 * refresh does not re-offer approve/deny on a cancelled run.
 */
export function neutralizeSessionDecisionParts<
  T extends { role: string; parts: Array<Record<string, unknown> & { type: string }> },
>(messages: T[]): T[] {
  return messages.map((m) => {
    if (m.role !== "assistant") {
      return m;
    }
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (
          typeof p.type === "string" &&
          p.type === "tool-request_user_decision" &&
          p.state === "input-available"
        ) {
          return {
            ...p,
            state: "output-denied",
            output: { cancelled: true },
          };
        }
        if (p.type === "data-choice" && p.data && typeof p.data === "object") {
          const data = p.data as Record<string, unknown>;
          return {
            ...p,
            data: {
              ...data,
              cancelled: true,
              options: [],
              mode: "input_only",
            },
          };
        }
        return p;
      }),
    };
  });
}

/**
 * AI SDK UI message stream for conversational Session.
 *
 * Body (preferred): { message (last only), id?, resumeData?, runId?, step? }
 * Body (legacy):    { messages (full client history), resumeData?, runId?, step? }
 *
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
  const session = await loadOperatorSession(workspace.rootPath, sessionId);
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

  // Server is source of truth: load history, append only the new last message.
  // Preferred: body.message (last only). Legacy: last entry of body.messages[].
  const previousUI = sessionMessagesToUIMessages(session.messages);
  let lastFromClient: UIMessage | undefined;
  if (body.message && typeof body.message === "object") {
    lastFromClient = body.message as UIMessage;
  } else if (Array.isArray(body.messages) && body.messages.length > 0) {
    // Multi-message fallback for older clients: take only the trailing user turn.
    lastFromClient = body.messages[body.messages.length - 1] as UIMessage;
  }

  if (
    !lastFromClient ||
    typeof lastFromClient !== "object" ||
    lastFromClient.role !== "user"
  ) {
    sendError(
      res,
      400,
      "chat body must include a user message (message or messages[])",
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
  // Free-text approve/deny and structured resumeData both need a live suspend.
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
  const phase = session.workflow?.phase ?? "idle";
  const looksLikeResume =
    Boolean(body.resumeData) ||
    lastText === "approve" ||
    lastText === "deny" ||
    // Free-text at plan gate is revision feedback (structured resume).
    (phase === "awaiting_plan" &&
      lastText.length > 0 &&
      lastText !== "revise");
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

  const messages: UIMessage[] = [...previousUI, lastFromClient];

  // Reject concurrent turns for the same session (double-submit before finalize).
  const lockKey = sessionChatLockKey(workspace.rootPath, sessionId);
  if (sessionChatInFlight.has(lockKey)) {
    sendError(res, 409, "session chat turn already in progress");
    return;
  }
  sessionChatInFlight.add(lockKey);

  // Once the server drain task is scheduled, only finalizeOnce may release the lock.
  let serverDrainOwnsLock = false;
  // Track abort registration so setup failures before drain can clear the map.
  let registeredAbortRunId: string | undefined;

  try {
    // abortSignalForRun registers AbortController when mode/runId are known
    // (sync, before stream execute) so Stop → abortRun can hard-stop mid-step.
    const chat = await createSessionWorkflowStream({
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
    });

    // Eager run registry on start so explicit Session Stop → cancel can target
    // the job while the first stream is still open (before finalize upsert).
    if (chat.mode === "start" && chat.runId) {
      try {
        const existing = await loadRun(workspace.rootPath, chat.runId);
        if (!existing) {
          let frozenSkillPath: string | undefined;
          let frozenSkillDigest: string | undefined;
          try {
            frozenSkillPath = await resolveSkillPath({
              skillPath: workspace.skillPath,
              workspaceRoot: workspace.rootPath,
            });
            frozenSkillDigest = await skillDigest(frozenSkillPath);
          } catch {
            // optional freeze
          }
          await registerRunRecord(workspace.rootPath, workspace.id, {
            runId: chat.runId,
            status: "running",
            summary: "Session Wiki Run started",
            skillPath: frozenSkillPath,
            skillDigest: frozenSkillDigest,
            sessionId,
          });
        }
      } catch (error) {
        process.stderr.write(
          `session eager run register failed: ${redactErrorMessage(error)}\n`,
        );
      }
    }

    let finalized = false;
    const finalizeOnce = async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      try {
        const result = await chat.finalize();
        let workflow = { ...result.workflow };
        let sessionStatus = result.status;
        let sessionPending = result.pending;

        if (result.sideEffects?.upsertRun) {
          const u = result.sideEffects.upsertRun;
          try {
            let frozenSkillPath: string | undefined;
            let frozenSkillDigest: string | undefined;
            try {
              frozenSkillPath = await resolveSkillPath({
                skillPath: workspace.skillPath,
                workspaceRoot: workspace.rootPath,
              });
              frozenSkillDigest = await skillDigest(frozenSkillPath);
            } catch {
              // optional freeze
            }
            const existing = await loadRun(workspace.rootPath, u.runId);
            // Late abort / cancel must not rewrite durable publish outcomes
            // (same rule as processRunInBackground / cancelUnlessDurableSuccess).
            const durableSuccess =
              u.status === "published" || u.status === "publication_declined";
            const cancelledWin =
              !durableSuccess &&
              (existing?.status === "cancelled" || u.status === "cancelled");
            // Explicit Stop/cancel may mark the run cancelled while the stream
            // still drains. Cancel wins on the record; reset session gate state.
            if (cancelledWin) {
              workflow = {
                ...workflow,
                linkedRunId: u.runId,
                phase: "idle",
              };
              sessionStatus = "active";
              sessionPending = null;
              // Neutralize any mid-stream decision chips so durable history
              // does not leave actionable HITL after cancel.
              result.messages = neutralizeSessionDecisionParts(result.messages);
              if (!existing) {
                await registerRunRecord(workspace.rootPath, workspace.id, {
                  runId: u.runId,
                  status: "cancelled",
                  pages: u.pages,
                  summary: u.summary ?? "Wiki Run cancelled",
                  skillPath: frozenSkillPath,
                  skillDigest: frozenSkillDigest,
                  sessionId: u.sessionId ?? sessionId,
                });
              } else if (existing.status !== "cancelled") {
                await updateRunRecord(workspace.rootPath, u.runId, {
                  status: "cancelled",
                  pages: u.pages ?? null,
                  summary: u.summary ?? "Wiki Run cancelled",
                  error: "cancelled",
                  ...(u.sessionId || sessionId
                    ? { sessionId: u.sessionId ?? sessionId }
                    : {}),
                }).catch(() => undefined);
              }
            } else if (!existing) {
              await registerRunRecord(workspace.rootPath, workspace.id, {
                runId: u.runId,
                status: (u.status as WikiRunRecordStatus) ?? "running",
                pages: u.pages,
                summary: u.summary,
                skillPath: frozenSkillPath,
                skillDigest: frozenSkillDigest,
                sessionId: u.sessionId ?? sessionId,
              });
              workflow = {
                ...workflow,
                linkedRunId: u.runId,
              };
            } else {
              // Registry cancel-wins: if cancel already landed, updateRunRecord
              // keeps cancelled; session still reflects durableSuccess above.
              await updateRunRecord(workspace.rootPath, u.runId, {
                status: u.status as WikiRunRecordStatus,
                pages: u.pages ?? null,
                summary: u.summary ?? null,
                ...(u.plan ? { plan: u.plan } : {}),
                ...(u.sessionId || sessionId
                  ? { sessionId: u.sessionId ?? sessionId }
                  : {}),
                error: null,
              }).catch(() => undefined);
              workflow = {
                ...workflow,
                linkedRunId: u.runId,
              };
            }
          } catch (error) {
            process.stderr.write(
              `session run upsert failed: ${redactErrorMessage(error)}\n`,
            );
          }
        }

        // Cancel-vs-finalize TOCTOU: handleCancelRun may mark the run cancelled
        // after our loadRun snapshot (or after we wrote awaiting_*), then clean
        // the session. Re-read before replaceSessionMessages so a late finalize
        // cannot restore gate HITL over cancel cleanup.
        // Do not apply when the turn already produced a durable publish outcome.
        const linkedRunId =
          result.sideEffects?.upsertRun?.runId ?? chat.runId ?? undefined;
        const upsertStatus = result.sideEffects?.upsertRun?.status;
        const turnDurableSuccess =
          upsertStatus === "published" ||
          upsertStatus === "publication_declined";
        if (linkedRunId && !turnDurableSuccess) {
          try {
            const latest = await loadRun(workspace.rootPath, linkedRunId);
            if (latest?.status === "cancelled") {
              workflow = {
                ...workflow,
                linkedRunId,
                phase: "idle",
              };
              sessionStatus = "active";
              sessionPending = null;
              result.messages = neutralizeSessionDecisionParts(result.messages);
            }
          } catch {
            // best-effort; prefer writing stream outcome over blocking finalize
          }
        }

        // Persist full UIMessage timeline (text + tool + data parts), not only finalText.
        await replaceSessionMessages(
          workspace.rootPath,
          sessionId,
          result.messages,
          {
            status: sessionStatus,
            pending: sessionPending,
            workflow,
          },
        );

        // Post-write cancel barrier: cancel may land between the re-read above
        // and replaceSessionMessages, restoring gate HITL over cancel cleanup.
        // Skip when this turn already produced a durable publish outcome so a
        // cancel-wins run record cannot clobber session phase done/completed.
        if (linkedRunId && !turnDurableSuccess) {
          try {
            const after = await loadRun(workspace.rootPath, linkedRunId);
            if (after?.status === "cancelled") {
              const current = await loadOperatorSession(
                workspace.rootPath,
                sessionId,
              );
              if (
                current &&
                current.workflow?.phase !== "done" &&
                current.status !== "completed" &&
                (current.workflow?.phase === "awaiting_plan" ||
                  current.workflow?.phase === "awaiting_publish" ||
                  current.pending != null ||
                  current.status === "waiting")
              ) {
                await replaceSessionMessages(
                  workspace.rootPath,
                  sessionId,
                  neutralizeSessionDecisionParts(current.messages),
                  {
                    status: "active",
                    pending: null,
                    workflow: {
                      ...current.workflow,
                      linkedRunId,
                      phase: "idle",
                    },
                  },
                );
              }
            }
          } catch {
            // best-effort second pass
          }
        }
      } catch (error) {
        process.stderr.write(
          `session chat finalize failed: ${redactErrorMessage(error)}\n`,
        );
      } finally {
        sessionChatInFlight.delete(lockKey);
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
      sessionChatInFlight.delete(lockKey);
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
