/**
 * Reconcile durable Operator Session gate state with the linked Wiki Run record.
 * Used on session load (refresh) so UI does not re-offer an already-answered gate
 * while the run is still writing, or leave status stuck as "running" at a real gate.
 */

import type {
  OperatorSession,
  SessionMessage,
  SessionWorkflowState,
  WikiRunRecordStatus,
} from "@okf-wiki/contract";
import { neutralizeSessionDecisionParts } from "./session-store.js";

export type SessionRunSnapshot = {
  status: WikiRunRecordStatus;
  plan?: OperatorSession["workflow"]["plan"];
  pages?: string[] | null;
  summary?: string | null;
};

export type SessionReconcilePatch = {
  status?: OperatorSession["status"];
  pending?: OperatorSession["pending"];
  workflow?: Partial<SessionWorkflowState>;
  messages?: SessionMessage[];
  /** True when durable session should be rewritten. */
  changed: boolean;
};

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
    case "needs_input":
    default:
      return "idle";
  }
}

function sessionStatusForRunStatus(
  status: WikiRunRecordStatus,
): OperatorSession["status"] {
  switch (status) {
    case "awaiting_plan":
    case "awaiting_publication":
      return "waiting";
    case "running":
      return "running";
    case "published":
      return "completed";
    case "failed":
      return "failed";
    case "publication_declined":
    case "cancelled":
    case "needs_input":
    default:
      return "active";
  }
}

function isGatePhase(phase: string | undefined): boolean {
  return phase === "awaiting_plan" || phase === "awaiting_publish";
}

/**
 * Pure reconcile: align session status/phase/pending/chips with linked run.
 * Returns `{ changed: false }` when no durable rewrite is needed.
 */
export function reconcileSessionWithRun(
  session: OperatorSession,
  run: SessionRunSnapshot | null | undefined,
): SessionReconcilePatch {
  if (!run) {
    // No run record: still fix inconsistent "running" while sitting on a gate.
    if (session.status === "running" && isGatePhase(session.workflow?.phase)) {
      return {
        changed: true,
        status: "waiting",
        pending: session.pending,
        workflow: { ...session.workflow },
      };
    }
    return { changed: false };
  }

  const runPhase = sessionPhaseForRunStatus(run.status);
  const runSessionStatus = sessionStatusForRunStatus(run.status);
  const linkedRunId = session.workflow?.linkedRunId;
  const nextWorkflow: SessionWorkflowState = {
    ...session.workflow,
    ...(linkedRunId ? { linkedRunId } : {}),
    phase: runPhase,
    ...(run.plan ? { plan: run.plan } : {}),
  };

  // Run is actively writing/planning — leave gate UI behind.
  if (run.status === "running") {
    const hasActionableGate =
      session.pending != null ||
      isGatePhase(session.workflow?.phase) ||
      session.status === "waiting" ||
      session.messages.some((m) =>
        m.parts.some((p) => {
          if (
            p.type === "tool-request_user_decision" &&
            "state" in p &&
            p.state === "input-available"
          ) {
            return true;
          }
          if (
            (p.type === "data-gate" || p.type === "data-choice") &&
            "data" in p &&
            p.data &&
            typeof p.data === "object"
          ) {
            const d = p.data as { cancelled?: boolean; options?: unknown[] };
            return !d.cancelled && (d.options?.length ?? 0) > 0;
          }
          return false;
        }),
      );
    if (
      hasActionableGate ||
      session.status !== "running" ||
      session.workflow?.phase !== "writing"
    ) {
      return {
        changed: true,
        status: "running",
        pending: null,
        workflow: nextWorkflow,
        messages: neutralizeSessionDecisionParts(session.messages),
      };
    }
    return { changed: false };
  }

  // Run is at a real HITL gate — session must be waiting at the matching phase.
  if (run.status === "awaiting_plan" || run.status === "awaiting_publication") {
    const phaseOk = session.workflow?.phase === runPhase;
    const statusOk = session.status === "waiting";
    // pending may be null if only message chips carry the decision; that is ok
    // as long as phase/status match. Fix stuck "running" at a gate.
    if (!phaseOk || !statusOk) {
      return {
        changed: true,
        status: "waiting",
        pending: session.pending,
        workflow: nextWorkflow,
      };
    }
    return { changed: false };
  }

  // Terminal / idle run: clear stuck mid-flight or gate if session lags.
  if (
    session.status === "running" ||
    isGatePhase(session.workflow?.phase) ||
    session.pending != null
  ) {
    const terminalDone =
      run.status === "published" || run.status === "publication_declined";
    return {
      changed: true,
      status: runSessionStatus,
      pending: null,
      workflow: {
        ...nextWorkflow,
        phase: terminalDone ? "done" : runPhase === "idle" ? "idle" : runPhase,
      },
      messages: neutralizeSessionDecisionParts(session.messages),
    };
  }

  // Align phase when session says done/idle but run terminal differs slightly.
  if (
    (run.status === "published" || run.status === "publication_declined") &&
    session.workflow?.phase !== "done" &&
    session.workflow?.phase !== "idle"
  ) {
    return {
      changed: true,
      status: runSessionStatus,
      pending: null,
      workflow: { ...nextWorkflow, phase: "done" },
    };
  }

  return { changed: false };
}

/** Map resume/start mode → mid-turn phase written before the long workflow finishes. */
export function midTurnPhaseForChat(input: {
  mode: "start" | "resume" | "help";
  resumeAction?: "approve" | "deny" | "revise";
  gateStep?: string;
  previousPhase?: string;
}): SessionWorkflowState["phase"] {
  if (input.mode === "start") {
    return "planning";
  }
  if (input.mode !== "resume") {
    return (input.previousPhase as SessionWorkflowState["phase"]) ?? "idle";
  }
  if (input.resumeAction === "revise") {
    return "planning";
  }
  if (input.resumeAction === "deny") {
    // Deny closes the run quickly; still mark mid-flight so refresh does not re-offer chips.
    return "writing";
  }
  // approve plan or publish → write / publish work in flight
  return "writing";
}
