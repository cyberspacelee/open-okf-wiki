/**
 * Eager mid-turn durability for Session chat (run registry + gate-exit persist).
 */

import type { UIMessage } from "ai";
import type {
  OperatorSession,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import type { SessionStreamBody } from "@okf-wiki/agent";
import {
  redactErrorMessage,
  uiMessagesToSessionMessages,
} from "@okf-wiki/agent";
import {
  loadRun,
  midTurnPhaseForChat,
  neutralizeSessionDecisionParts,
  registerRunRecord,
  replaceSessionMessages,
  resolveSkillPath,
  skillDigest,
  transition,
  updateRunRecord,
} from "@okf-wiki/core";

export async function eagerRegisterStartRun(input: {
  workspace: WorkspaceConfig;
  sessionId: string;
  runId: string;
}): Promise<void> {
  try {
    const existing = await loadRun(input.workspace.rootPath, input.runId);
    if (existing) {
      return;
    }
    let frozenSkillPath: string | undefined;
    let frozenSkillDigest: string | undefined;
    try {
      frozenSkillPath = await resolveSkillPath({
        skillPath: input.workspace.skillPath,
        workspaceRoot: input.workspace.rootPath,
      });
      frozenSkillDigest = await skillDigest(frozenSkillPath);
    } catch {
      // optional freeze
    }
    await registerRunRecord(input.workspace.rootPath, input.workspace.id, {
      runId: input.runId,
      status: "running",
      summary: "Session Wiki Run started",
      skillPath: frozenSkillPath,
      skillDigest: frozenSkillDigest,
      sessionId: input.sessionId,
    });
  } catch (error) {
    process.stderr.write(
      `session eager run register failed: ${redactErrorMessage(error)}\n`,
    );
  }
}

/**
 * Eager gate-exit / mid-turn durability (ADR 0026 I6):
 * Persist running + neutralize decision chips as soon as start/resume
 * begins so a page refresh does not re-offer an already-answered plan gate
 * while write work is still in flight. Phase/status via P2 transition.
 */
export async function eagerMidTurnPersist(input: {
  workspace: WorkspaceConfig;
  session: OperatorSession;
  sessionId: string;
  mode: "start" | "resume";
  runId?: string;
  body: SessionStreamBody;
  lastFromClient: UIMessage;
}): Promise<void> {
  try {
    const midPhase = midTurnPhaseForChat({
      mode: input.mode,
      resumeAction: input.body.resumeData?.action,
      gateStep: input.body.step,
      previousPhase: input.session.workflow?.phase,
    });
    const linked =
      input.runId ??
      (typeof input.body.runId === "string" ? input.body.runId : undefined) ??
      input.session.workflow?.linkedRunId;
    const withUser = [
      ...neutralizeSessionDecisionParts(input.session.messages),
      ...uiMessagesToSessionMessages([input.lastFromClient]),
    ];
    // Session only: do NOT flip run off awaiting_* here. Run becomes
    // running in onWorkflowLive after Mastra open succeeds. If we crash
    // before that, reconcile restores the gate from the run record.
    const event =
      input.mode === "start" && linked
        ? ({
            type: "TurnStarted" as const,
            runId: linked,
            phase: midPhase,
          })
        : linked
          ? ({
              type: "WorkflowLive" as const,
              runId: linked,
              phase: midPhase,
            })
          : null;
    const patches = event
      ? transition(event, {
          sessionStatus: input.session.status,
          workflowPhase: input.session.workflow?.phase ?? "idle",
          linkedRunId: input.session.workflow?.linkedRunId,
          pending: input.session.pending,
          plan: input.session.workflow?.plan,
        })
      : null;
    await replaceSessionMessages(
      input.workspace.rootPath,
      input.sessionId,
      withUser,
      {
        status: patches?.session?.status ?? "running",
        pending:
          patches?.session && "pending" in patches.session
            ? (patches.session.pending ?? null)
            : null,
        workflow: {
          ...input.session.workflow,
          ...(patches?.session?.workflow ?? {}),
          ...(linked ? { linkedRunId: linked } : {}),
          phase: patches?.session?.workflow?.phase ?? midPhase,
        },
      },
    );
  } catch (error) {
    process.stderr.write(
      `session eager mid-turn persist failed: ${redactErrorMessage(error)}\n`,
    );
  }
}

export async function markRunWorkflowLive(input: {
  workspaceRoot: string;
  sessionId: string;
  liveRunId: string;
}): Promise<void> {
  try {
    const existing = await loadRun(input.workspaceRoot, input.liveRunId);
    if (!existing) {
      return;
    }
    if (
      existing.status === "awaiting_plan" ||
      existing.status === "awaiting_publication" ||
      existing.status === "running"
    ) {
      const livePatches = transition(
        { type: "WorkflowLive", runId: input.liveRunId },
        {
          sessionStatus: "running",
          workflowPhase: "planning",
          linkedRunId: input.liveRunId,
          runStatus: existing.status,
        },
      );
      if (livePatches.ignore) {
        return;
      }
      await updateRunRecord(input.workspaceRoot, input.liveRunId, {
        status: livePatches.run?.status ?? "running",
        summary: livePatches.run?.summary ?? "Wiki Run in progress",
        error: null,
        sessionId: input.sessionId,
      }).catch(() => undefined);
    }
  } catch {
    // best-effort
  }
}
