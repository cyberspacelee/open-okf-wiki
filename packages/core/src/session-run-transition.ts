/**
 * P2 — Session–Run pure transition table (ADR 0027).
 * Single product map: workflow/run events → Session + Run patches.
 * No I/O, no Mastra. Callers apply patches via stores / stream side-effects.
 */

import type {
  OperatorSession,
  PendingInteraction,
  SessionWorkflowState,
  WikiRunPlan,
  WikiRunRecordStatus,
} from "@okf-wiki/contract";
import {
  canTransitionToCancelled,
  cancelWinsOverPatch,
  isDurableRunStatus,
} from "./run-status-policy.js";

/** Minimal state snapshot the transition table reads. */
export type SessionRunState = {
  sessionStatus: OperatorSession["status"];
  workflowPhase: SessionWorkflowState["phase"];
  linkedRunId?: string | null;
  runStatus?: WikiRunRecordStatus | string | null;
  pending?: PendingInteraction | null;
  plan?: WikiRunPlan;
  pages?: string[];
  summary?: string;
};

/** Product-level events (not Mastra types). */
export type SessionRunEvent =
  | {
      type: "TurnStarted";
      runId: string;
      /** Mid-turn phase before workflow is live (default: planning). */
      phase?: SessionWorkflowState["phase"];
    }
  | {
      type: "WorkflowLive";
      runId: string;
      /** Live phase after open succeeds (default: writing). */
      phase?: SessionWorkflowState["phase"];
    }
  | {
      type: "WorkflowSuspended";
      runId?: string;
      gate: "plan" | "publication";
      plan?: WikiRunPlan;
      pages?: string[];
      summary?: string;
    }
  | {
      type: "WorkflowTerminal";
      runId?: string;
      status: WikiRunRecordStatus;
      plan?: WikiRunPlan;
      pages?: string[];
      summary?: string;
      error?: string | null;
    }
  | {
      type: "Cancel";
      runId?: string;
      summary?: string;
    }
  | {
      type: "ReconcileOnLoad";
      runStatus: WikiRunRecordStatus;
      plan?: WikiRunPlan;
      pages?: string[];
      summary?: string;
      gate?: "plan" | "publication";
    };

/** Optional trajectory fragment for adapters (not full message I/O). */
export type SessionRunAppendHint = {
  kind: "status";
  text: string;
  runId?: string;
  runStatus: WikiRunRecordStatus;
  plan?: WikiRunPlan;
  pages?: string[];
};

/**
 * Pure patches. Adapters apply session/run fields and optional appendHint.
 * `ignore: true` means durable cancel/status already won — do not rewrite.
 */
export type SessionRunPatches = {
  session?: {
    status?: OperatorSession["status"];
    pending?: PendingInteraction | null;
    workflow?: Partial<SessionWorkflowState>;
  };
  run?: {
    status?: WikiRunRecordStatus;
    plan?: WikiRunPlan;
    pages?: string[];
    summary?: string;
    error?: string | null;
  };
  appendHint?: SessionRunAppendHint;
  /** Leave a gate / terminal: neutralize stale HITL chips in history. */
  neutralizeDecisions?: boolean;
  /** Do not apply run/session writes (cancel or durable already won). */
  ignore?: boolean;
  ignoreReason?: string;
};

/** Session status + workflow phase for a product run status (single map). */
export function sessionProjectionForRunStatus(
  status: WikiRunRecordStatus | string,
): {
  sessionStatus: OperatorSession["status"];
  workflowPhase: SessionWorkflowState["phase"];
} {
  switch (status) {
    case "awaiting_plan":
      return { sessionStatus: "waiting", workflowPhase: "awaiting_plan" };
    case "awaiting_publication":
      return { sessionStatus: "waiting", workflowPhase: "awaiting_publish" };
    case "running":
      return { sessionStatus: "running", workflowPhase: "writing" };
    case "published":
      return { sessionStatus: "completed", workflowPhase: "done" };
    case "publication_declined":
      // Durable outcome: workflow done; session stays active for more turns.
      return { sessionStatus: "active", workflowPhase: "done" };
    case "failed":
      return { sessionStatus: "failed", workflowPhase: "idle" };
    case "cancelled":
      return { sessionStatus: "active", workflowPhase: "idle" };
    case "needs_input":
    default:
      return { sessionStatus: "active", workflowPhase: "idle" };
  }
}

function isGateRunStatus(status: string | undefined | null): boolean {
  return status === "awaiting_plan" || status === "awaiting_publication";
}

function isGatePhase(phase: string | undefined): boolean {
  return phase === "awaiting_plan" || phase === "awaiting_publish";
}

function failedSummary(error?: string | null, summary?: string): string {
  if (typeof error === "string" && error.trim()) {
    return `Wiki Run failed: ${error}`;
  }
  if (typeof summary === "string" && summary.trim()) {
    return summary;
  }
  return "Wiki Run failed";
}

function defaultStatusText(
  status: WikiRunRecordStatus,
  summary?: string,
  error?: string | null,
): string {
  if (status === "failed") {
    return failedSummary(error, summary);
  }
  if (typeof summary === "string" && summary.trim()) {
    return summary;
  }
  switch (status) {
    case "awaiting_plan":
      return "Awaiting plan confirmation";
    case "awaiting_publication":
      return "Awaiting publication approval";
    case "cancelled":
      return "Wiki Run cancelled";
    case "published":
      return "Published";
    case "publication_declined":
      return "Publication declined";
    case "running":
      return "Wiki Run running";
    default:
      return `Wiki Run ${status}`;
  }
}

/**
 * Unique Session–Run transition: event + state → patches.
 * Destructive / no legacy migrate branches.
 */
export function transition(
  event: SessionRunEvent,
  state: SessionRunState,
): SessionRunPatches {
  switch (event.type) {
    case "TurnStarted": {
      const phase = event.phase ?? "planning";
      const runId = event.runId;
      return {
        session: {
          status: "running",
          pending: null,
          workflow: {
            linkedRunId: runId,
            phase,
          },
        },
        run: {
          status: "running",
          summary: "Wiki Run started",
        },
        neutralizeDecisions:
          isGatePhase(state.workflowPhase) || state.pending != null,
      };
    }

    case "WorkflowLive": {
      const runId = event.runId;
      // Preserve planning mid-flight if TurnStarted already set it and caller
      // did not override; default live phase is writing.
      const phase =
        event.phase ??
        (state.workflowPhase === "planning" ? "planning" : "writing");
      return {
        session: {
          status: "running",
          pending: null,
          workflow: {
            linkedRunId: runId,
            phase,
          },
        },
        run: {
          status: "running",
        },
        neutralizeDecisions:
          isGatePhase(state.workflowPhase) ||
          isGateRunStatus(state.runStatus) ||
          state.pending != null,
      };
    }

    case "WorkflowSuspended": {
      const runStatus: WikiRunRecordStatus =
        event.gate === "publication"
          ? "awaiting_publication"
          : "awaiting_plan";
      const { sessionStatus, workflowPhase } =
        sessionProjectionForRunStatus(runStatus);
      const runId = event.runId ?? state.linkedRunId ?? undefined;
      const summary =
        event.summary ??
        (event.gate === "plan"
          ? "Awaiting plan confirmation"
          : "Awaiting publication approval");
      const plan = event.plan ?? state.plan;
      const pages = event.pages ?? state.pages;
      return {
        session: {
          status: sessionStatus,
          // Gate chips / pending are owned by UI map + ensureGateMessage;
          // do not invent pending here — only clear is wrong for suspend.
          workflow: {
            ...(runId ? { linkedRunId: runId } : {}),
            phase: workflowPhase,
            ...(plan ? { plan } : {}),
          },
        },
        run: {
          status: runStatus,
          ...(plan ? { plan } : {}),
          ...(pages ? { pages } : {}),
          summary,
          error: null,
        },
        appendHint: {
          kind: "status",
          text: summary,
          runId: runId ?? undefined,
          runStatus,
          ...(plan ? { plan } : {}),
          ...(pages ? { pages } : {}),
        },
      };
    }

    case "WorkflowTerminal": {
      // Cancel already recorded — keep it.
      if (cancelWinsOverPatch(state.runStatus ?? "", event.status)) {
        return {
          ignore: true,
          ignoreReason: "cancel_wins",
          session: {
            status: "active",
            pending: null,
            workflow: {
              phase: "idle",
              ...(state.linkedRunId
                ? { linkedRunId: state.linkedRunId }
                : {}),
            },
          },
          run: {
            status: "cancelled",
            summary: state.summary ?? "Wiki Run cancelled",
          },
          neutralizeDecisions: true,
        };
      }

      const { sessionStatus, workflowPhase } = sessionProjectionForRunStatus(
        event.status,
      );
      const runId = event.runId ?? state.linkedRunId ?? undefined;
      const plan = event.plan ?? state.plan;
      const pages = event.pages ?? state.pages;
      const summary =
        event.status === "failed"
          ? failedSummary(event.error, event.summary)
          : (event.summary ??
            defaultStatusText(event.status, event.summary, event.error));

      const leaveGate =
        !isGateRunStatus(event.status) ||
        isGatePhase(state.workflowPhase) ||
        state.pending != null;

      return {
        session: {
          status: sessionStatus,
          pending: isGateRunStatus(event.status) ? state.pending ?? null : null,
          workflow: {
            ...(runId ? { linkedRunId: runId } : {}),
            phase: workflowPhase,
            ...(plan ? { plan } : {}),
          },
        },
        run: {
          status: event.status,
          ...(plan ? { plan } : {}),
          ...(pages ? { pages } : {}),
          summary,
          ...(event.error !== undefined ? { error: event.error } : {}),
        },
        appendHint: {
          kind: "status",
          text: summary,
          runId: runId ?? undefined,
          runStatus: event.status,
          ...(plan ? { plan } : {}),
          ...(pages ? { pages } : {}),
        },
        neutralizeDecisions: leaveGate && !isGateRunStatus(event.status),
      };
    }

    case "Cancel": {
      const existing = state.runStatus ?? "";
      // Durable publish outcomes must not be rewritten by product cancel.
      if (isDurableRunStatus(existing)) {
        return {
          ignore: true,
          ignoreReason: "durable_outcome",
        };
      }
      if (!canTransitionToCancelled(existing || "running")) {
        return {
          ignore: true,
          ignoreReason: "not_cancellable",
        };
      }
      const runId = event.runId ?? state.linkedRunId ?? undefined;
      const summary = event.summary ?? "Wiki Run cancelled";
      return {
        session: {
          status: "active",
          pending: null,
          workflow: {
            ...(runId ? { linkedRunId: runId } : {}),
            phase: "idle",
          },
        },
        run: {
          status: "cancelled",
          summary,
          error: "cancelled",
        },
        appendHint: {
          kind: "status",
          text: summary,
          runId: runId ?? undefined,
          runStatus: "cancelled",
        },
        neutralizeDecisions: true,
      };
    }

    case "ReconcileOnLoad": {
      const { sessionStatus, workflowPhase } = sessionProjectionForRunStatus(
        event.runStatus,
      );
      const plan = event.plan ?? state.plan;
      const pages = event.pages ?? state.pages;
      const atGate = isGateRunStatus(event.runStatus);
      return {
        session: {
          status: sessionStatus,
          pending: atGate ? (state.pending ?? null) : null,
          workflow: {
            ...(state.linkedRunId
              ? { linkedRunId: state.linkedRunId }
              : {}),
            phase: workflowPhase,
            ...(plan ? { plan } : {}),
          },
        },
        run: {
          status: event.runStatus,
          ...(plan ? { plan } : {}),
          ...(pages ? { pages } : {}),
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
        },
        neutralizeDecisions: !atGate,
      };
    }

    default: {
      // Exhaustiveness — should be unreachable with typed events.
      const _never: never = event;
      void _never;
      return {};
    }
  }
}

/**
 * Convenience: build SessionTerminalView-shaped fields from a product terminal
 * status (agent/session-stream adapter). Pure — uses transition only.
 */
export function sessionViewFromRunStatus(input: {
  status: WikiRunRecordStatus;
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  error?: string;
  suspended?: boolean;
  suspendGate?: "plan" | "publication";
}): {
  status: OperatorSession["status"];
  workflowPhase: SessionWorkflowState["phase"];
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  runStatus: WikiRunRecordStatus;
} {
  if (input.suspended && input.suspendGate) {
    const patches = transition(
      {
        type: "WorkflowSuspended",
        gate: input.suspendGate,
        plan: input.plan,
        pages: input.pages,
        summary: input.summary,
      },
      {
        sessionStatus: "active",
        workflowPhase: "idle",
      },
    );
    return {
      status: patches.session?.status ?? "waiting",
      workflowPhase: patches.session?.workflow?.phase ?? "idle",
      pages: input.pages,
      plan: input.plan ?? patches.session?.workflow?.plan,
      summary: patches.run?.summary ?? input.summary,
      runStatus: patches.run?.status ?? input.status,
    };
  }

  const patches = transition(
    {
      type: "WorkflowTerminal",
      status: input.status,
      plan: input.plan,
      pages: input.pages,
      summary: input.summary,
      error: input.error,
    },
    {
      sessionStatus: "active",
      workflowPhase: "idle",
    },
  );

  return {
    status: patches.session?.status ?? "failed",
    workflowPhase: patches.session?.workflow?.phase ?? "idle",
    pages: input.pages ?? patches.run?.pages,
    plan: input.plan ?? patches.session?.workflow?.plan,
    summary: patches.run?.summary ?? input.summary,
    runStatus: patches.run?.status ?? input.status,
  };
}
