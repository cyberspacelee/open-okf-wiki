/**
 * Session chat turn finalize: apply SessionTurn side effects + durable journal.
 * Extracted from the HTTP route so sessions.ts stays a thin transport shell.
 */

import type { UIMessage } from "ai";
import type {
  OperatorSession,
  PendingInteraction,
  SessionMessage,
  SessionWorkflowState,
  WikiRunPlan,
  WikiRunRecordStatus,
} from "@okf-wiki/contract";
import {
  isDurableRunStatus,
  loadOperatorSession,
  loadRun,
  neutralizeSessionDecisionParts,
  registerRunRecord,
  replaceSessionMessages,
  resolveSkillPath,
  skillDigest,
  updateRunRecord,
} from "@okf-wiki/core";
import { redactErrorMessage } from "@okf-wiki/agent";

export type SessionChatFinalizeInput = {
  workspaceRoot: string;
  workspaceId: string;
  workspaceSkillPath?: string;
  sessionId: string;
  /** Last user message id — used when finalize recovery appends an error. */
  lastUserMessageId: string;
  lastUserMessage: UIMessage;
  chat: {
    runId?: string;
    finalize: () => Promise<{
      messages: SessionMessage[];
      status: OperatorSession["status"];
      pending: PendingInteraction | null;
      workflow: Partial<SessionWorkflowState>;
      sideEffects?: {
        upsertRun?: {
          runId: string;
          status: string;
          pages?: string[];
          plan?: WikiRunPlan;
          summary?: string;
          sessionId?: string;
        };
      };
    }>;
  };
  /** Convert UI messages when recovery must re-append the user turn. */
  uiMessagesToSessionMessages: (messages: UIMessage[]) => SessionMessage[];
};

async function freezeSkill(input: {
  skillPath?: string;
  workspaceRoot: string;
}): Promise<{ skillPath?: string; skillDigest?: string }> {
  try {
    const frozenSkillPath = await resolveSkillPath({
      skillPath: input.skillPath,
      workspaceRoot: input.workspaceRoot,
    });
    const frozenSkillDigest = await skillDigest(frozenSkillPath);
    return { skillPath: frozenSkillPath, skillDigest: frozenSkillDigest };
  } catch {
    return {};
  }
}

/**
 * Drain-side finalize: upsert run record, cancel-wins barriers, replace session
 * messages. Idempotent when called once via finalizeOnce on the route.
 */
export async function finalizeSessionChatTurn(
  input: SessionChatFinalizeInput,
): Promise<void> {
  const {
    workspaceRoot,
    workspaceId,
    workspaceSkillPath,
    sessionId,
    lastUserMessageId,
    lastUserMessage,
    chat,
    uiMessagesToSessionMessages,
  } = input;

  try {
    const result = await chat.finalize();
    let workflow = { ...result.workflow };
    let sessionStatus = result.status;
    let sessionPending = result.pending;

    if (result.sideEffects?.upsertRun) {
      const u = result.sideEffects.upsertRun;
      try {
        const frozen = await freezeSkill({
          skillPath: workspaceSkillPath,
          workspaceRoot,
        });
        const existing = await loadRun(workspaceRoot, u.runId);
        // Late abort / cancel must not rewrite durable publish outcomes
        // (same rule as wiki-run-job / isDurableRunStatus).
        const durableSuccess = isDurableRunStatus(u.status);
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
            await registerRunRecord(workspaceRoot, workspaceId, {
              runId: u.runId,
              status: "cancelled",
              pages: u.pages,
              summary: u.summary ?? "Wiki Run cancelled",
              skillPath: frozen.skillPath,
              skillDigest: frozen.skillDigest,
              sessionId: u.sessionId ?? sessionId,
            });
          } else if (existing.status !== "cancelled") {
            await updateRunRecord(workspaceRoot, u.runId, {
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
          await registerRunRecord(workspaceRoot, workspaceId, {
            runId: u.runId,
            status: (u.status as WikiRunRecordStatus) ?? "running",
            pages: u.pages,
            summary: u.summary,
            skillPath: frozen.skillPath,
            skillDigest: frozen.skillDigest,
            sessionId: u.sessionId ?? sessionId,
          });
          workflow = {
            ...workflow,
            linkedRunId: u.runId,
          };
        } else {
          // Registry cancel-wins: if cancel already landed, updateRunRecord
          // keeps cancelled; session still reflects durableSuccess above.
          await updateRunRecord(workspaceRoot, u.runId, {
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
        const latest = await loadRun(workspaceRoot, linkedRunId);
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
    // Always clear answered gates on older assistant turns so refresh cannot
    // re-offer a plan chip after approve (finishedMessages may still carry them).
    const durableMessages = neutralizeSessionDecisionParts(result.messages, {
      // Keep chips only when this turn re-opened a gate (pending set).
      keepLatestAssistant: sessionPending != null,
    });
    await replaceSessionMessages(workspaceRoot, sessionId, durableMessages, {
      status: sessionStatus,
      pending: sessionPending,
      workflow,
    });

    // Post-write cancel barrier: cancel may land between the re-read above
    // and replaceSessionMessages, restoring gate HITL over cancel cleanup.
    // Skip when this turn already produced a durable publish outcome so a
    // cancel-wins run record cannot clobber session phase done/completed.
    if (linkedRunId && !turnDurableSuccess) {
      try {
        const after = await loadRun(workspaceRoot, linkedRunId);
        if (after?.status === "cancelled") {
          const current = await loadOperatorSession(workspaceRoot, sessionId);
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
              workspaceRoot,
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
    // Do not silently drop timeline — log and attempt to keep prior history
    // while recording a durable assistant error so refresh is not empty.
    process.stderr.write(
      `session chat finalize failed: ${redactErrorMessage(error)}\n`,
    );
    try {
      const prior = await loadOperatorSession(workspaceRoot, sessionId);
      if (prior) {
        const errMsg = {
          id: `finalize-error-${Date.now()}`,
          role: "assistant" as const,
          parts: [
            {
              type: "text" as const,
              text: `Session save failed: ${redactErrorMessage(error)}. Prior history retained; retry or start a new turn.`,
            },
          ],
          createdAt: new Date().toISOString(),
        };
        // Only append error if the user turn was already in prior; else full messages may be incomplete.
        const hasUser = prior.messages.some((m) => m.id === lastUserMessageId);
        await replaceSessionMessages(
          workspaceRoot,
          sessionId,
          hasUser
            ? [...prior.messages, errMsg]
            : [
                ...prior.messages,
                ...uiMessagesToSessionMessages([lastUserMessage]),
                errMsg,
              ],
          {
            status: "failed",
            pending: null,
          },
        );
      }
    } catch (secondary) {
      process.stderr.write(
        `session chat finalize recovery failed: ${redactErrorMessage(secondary)}\n`,
      );
    }
  }
}
