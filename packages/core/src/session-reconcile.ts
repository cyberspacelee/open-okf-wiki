/**
 * Reconcile durable Operator Session gate state with the linked Wiki Run record.
 * Used on session load (refresh) so UI does not re-offer an already-answered gate
 * while the run is still writing, or leave status stuck as "running" at a real gate.
 *
 * Crash consistency:
 * - Eager mid-flight only updates the session (phase writing/planning).
 * - Run becomes `running` only after Mastra open succeeds (`onWorkflowLive`).
 * - Session mid-flight + run still awaiting_* ⇒ orphaned eager (crash before open)
 *   → restore the gate so the operator can re-approve.
 */

import { randomUUID } from "node:crypto";
import type {
  OperatorSession,
  PendingInteraction,
  SessionMessage,
  SessionWorkflowState,
  WikiRunPlan,
  WikiRunRecordStatus,
} from "@okf-wiki/contract";
import { mapRunGateToGateUi } from "@okf-wiki/contract";
import { neutralizeSessionDecisionParts } from "./session-store.js";
import { sessionProjectionForRunStatus } from "./session-run-transition.js";

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

/** Soft lock: session turn considered in-flight if status=running and not stale. */
export const SESSION_TURN_LOCK_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export function isSessionTurnLocked(
  session: Pick<OperatorSession, "status" | "updatedAt">,
  nowMs = Date.now(),
): boolean {
  if (session.status !== "running") {
    return false;
  }
  const updated = Date.parse(session.updatedAt);
  if (Number.isNaN(updated)) {
    return true;
  }
  return nowMs - updated < SESSION_TURN_LOCK_MAX_AGE_MS;
}

function isGatePhase(phase: string | undefined): boolean {
  return phase === "awaiting_plan" || phase === "awaiting_publish";
}

function isMidFlightPhase(phase: string | undefined): boolean {
  return phase === "planning" || phase === "writing";
}

function hasActionableGateParts(messages: SessionMessage[]): boolean {
  return messages.some((m) =>
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
}

/**
 * Ensure a live data-gate part exists for the current run gate (old sessions /
 * orphan recovery). Appends a small assistant message when needed.
 * Options come only from mapRunGateToGateUi (shared with session-stream).
 */
export function ensureGateMessage(
  messages: SessionMessage[],
  input: {
    gate: "plan" | "publication";
    plan?: WikiRunPlan;
    pages?: string[] | null;
  },
): { messages: SessionMessage[]; pending: PendingInteraction; changed: boolean } {
  const gateUi = mapRunGateToGateUi({
    gate: input.gate,
    plan: input.plan,
    pages: input.pages,
  });
  // Fallback pending when plan is missing at plan-gate (should be rare).
  const pending: PendingInteraction = gateUi?.pending ?? {
    type: input.gate === "plan" ? "approval" : "confirmation",
    question:
      input.gate === "plan"
        ? "How do you want to proceed with this plan?"
        : "Publish the staged wiki?",
    mode: input.gate === "plan" ? "choice_or_input" : "choice_only",
    selectionMode: "single",
    options: [],
  };

  if (hasActionableGateParts(messages)) {
    // Prefer existing live chips; still surface pending meta from the single map.
    return { messages, pending, changed: false };
  }

  const parts: SessionMessage["parts"] = [
    {
      type: "text",
      text:
        input.gate === "plan"
          ? "Restored plan gate after refresh (workflow still awaiting confirmation)."
          : "Restored publication gate after refresh.",
      state: "done",
    },
    {
      type: "data-gate",
      id: randomUUID(),
      data: {
        ...pending,
        gate: input.gate,
        cancelled: false,
      },
    } as SessionMessage["parts"][number],
  ];
  if (input.plan && input.gate === "plan") {
    parts.push({
      type: "data-plan",
      id: randomUUID(),
      data: input.plan,
    } as SessionMessage["parts"][number]);
  }

  return {
    messages: [
      ...messages,
      {
        id: `gate-restore-${randomUUID()}`,
        role: "assistant",
        parts,
        createdAt: new Date().toISOString(),
      },
    ],
    pending,
    changed: true,
  };
}

/**
 * Migrate legacy decision tool / data-choice into data-gate when at a real gate.
 */
export function migrateLegacyGateParts(
  messages: SessionMessage[],
  gate: "plan" | "publication",
  plan?: WikiRunPlan,
  pages?: string[] | null,
): { messages: SessionMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "assistant") {
      return m;
    }
    let msgChanged = false;
    const parts = m.parts.flatMap((p) => {
      if (
        p.type === "tool-request_user_decision" &&
        "state" in p &&
        p.state === "input-available" &&
        "input" in p &&
        p.input
      ) {
        msgChanged = true;
        changed = true;
        const input = p.input as PendingInteraction;
        return [
          {
            type: "data-gate",
            id: randomUUID(),
            data: {
              ...input,
              gate,
              cancelled: false,
            },
          } as SessionMessage["parts"][number],
        ];
      }
      if (p.type === "data-choice" && "data" in p && p.data) {
        const d = p.data as PendingInteraction & { cancelled?: boolean };
        if (!d.cancelled && (d.options?.length ?? 0) > 0) {
          msgChanged = true;
          changed = true;
          return [
            {
              type: "data-gate",
              id: randomUUID(),
              data: {
                ...d,
                gate,
                cancelled: false,
              },
            } as SessionMessage["parts"][number],
          ];
        }
      }
      return [p];
    });
    return msgChanged ? { ...m, parts } : m;
  });

  if (hasActionableGateParts(next)) {
    return { messages: next, changed };
  }

  // No live gate parts at all — rehydrate from run plan/pages.
  const ensured = ensureGateMessage(next, { gate, plan, pages });
  return {
    messages: ensured.messages,
    changed: changed || ensured.changed,
  };
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
    // Stale durable turn lock with no run — clear mid-flight.
    if (
      session.status === "running" &&
      isMidFlightPhase(session.workflow?.phase) &&
      !isSessionTurnLocked(session)
    ) {
      return {
        changed: true,
        status: "active",
        pending: null,
        workflow: { ...session.workflow, phase: "idle" },
        messages: neutralizeSessionDecisionParts(session.messages),
      };
    }
    return { changed: false };
  }

  // Single P2 map for run status → session status/phase (no local phase copies).
  const projection = sessionProjectionForRunStatus(run.status);
  const runPhase = projection.workflowPhase;
  const runSessionStatus = projection.sessionStatus;
  const linkedRunId = session.workflow?.linkedRunId;
  const nextWorkflow: SessionWorkflowState = {
    ...session.workflow,
    ...(linkedRunId ? { linkedRunId } : {}),
    phase: runPhase,
    ...(run.plan ? { plan: run.plan } : {}),
  };

  // Run is actively writing — leave gate UI behind.
  if (run.status === "running") {
    const hasActionableGate =
      session.pending != null ||
      isGatePhase(session.workflow?.phase) ||
      session.status === "waiting" ||
      hasActionableGateParts(session.messages);
    if (
      hasActionableGate ||
      session.status !== "running" ||
      !isMidFlightPhase(session.workflow?.phase)
    ) {
      return {
        changed: true,
        status: "running",
        pending: null,
        workflow: {
          ...nextWorkflow,
          phase:
            session.workflow?.phase === "planning" ? "planning" : "writing",
        },
        messages: neutralizeSessionDecisionParts(session.messages),
      };
    }
    return { changed: false };
  }

  // Run still at a real HITL gate.
  if (run.status === "awaiting_plan" || run.status === "awaiting_publication") {
    const gate: "plan" | "publication" =
      run.status === "awaiting_publication" ? "publication" : "plan";

    // Orphan recovery: session thinks mid-flight but run never left the gate
    // (crash after eager session write, before onWorkflowLive).
    if (
      session.status === "running" ||
      isMidFlightPhase(session.workflow?.phase)
    ) {
      const migrated = migrateLegacyGateParts(
        neutralizeSessionDecisionParts(session.messages),
        gate,
        run.plan ?? session.workflow?.plan,
        run.pages,
      );
      const ensured = ensureGateMessage(migrated.messages, {
        gate,
        plan: run.plan ?? session.workflow?.plan,
        pages: run.pages,
      });
      return {
        changed: true,
        status: "waiting",
        pending: ensured.pending,
        workflow: nextWorkflow,
        messages: ensured.messages,
      };
    }

    const phaseOk = session.workflow?.phase === runPhase;
    const statusOk = session.status === "waiting";
    const migrated = migrateLegacyGateParts(
      session.messages,
      gate,
      run.plan ?? session.workflow?.plan,
      run.pages,
    );
    if (!phaseOk || !statusOk || migrated.changed) {
      const ensured = ensureGateMessage(migrated.messages, {
        gate,
        plan: run.plan ?? session.workflow?.plan,
        pages: run.pages,
      });
      return {
        changed: true,
        status: "waiting",
        pending: ensured.pending,
        workflow: nextWorkflow,
        messages: ensured.messages,
      };
    }
    return { changed: false };
  }

  // Terminal / idle run: clear stuck mid-flight or gate if session lags.
  if (
    session.status === "running" ||
    isGatePhase(session.workflow?.phase) ||
    isMidFlightPhase(session.workflow?.phase) ||
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
    return "writing";
  }
  return "writing";
}
