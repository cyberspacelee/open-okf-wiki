/**
 * WikiRunShell — thin product phase machine for Wiki Runs (ADR 0030).
 *
 * Owns plan → produce → hard-validate → publish gates.
 * Pi owns conversation/tools; this module is pure TypeScript (no Mastra).
 */

import type { WikiRunPlan } from "@okf-wiki/contract";
import type { ResumeGateInput } from "./gates.js";
import {
  transitionCancelled,
  transitionEnterPlanGate,
  transitionFailed,
  transitionMarkAwaitingPublish,
  transitionMarkHardValidate,
  transitionMarkProducing,
  transitionPublicationDeclined,
  transitionPublished,
  transitionResumeGate,
  type WikiRunShellPhase,
  type WikiRunShellState,
} from "./transitions.js";

export type {
  ResumeGateInput,
  WikiRunGateAction,
  WikiRunGateKind,
} from "./gates.js";
export {
  assertValidResumeGate,
  isWikiRunGateAction,
  isWikiRunGateKind,
} from "./gates.js";
export type {
  WikiRunShellPhase,
  WikiRunShellState,
} from "./transitions.js";
export { applyPlanRevision, isTerminalPhase } from "./transitions.js";

export type StartShellInput = {
  /** Pre-generated or frozen Spec. */
  plan?: WikiRunPlan;
  /**
   * When true with a plan, skip plan gate (ready for markProducing).
   * When false/omitted with a plan, start suspended at plan gate.
   */
  skipPlanConfirm?: boolean;
  summary?: string;
};

/**
 * Create a new shell state.
 * - no plan → idle
 * - plan + skipPlanConfirm → idle with plan (ready to produce)
 * - plan without skip → awaiting_plan
 */
export function startShell(input: StartShellInput = {}): WikiRunShellState {
  if (input.plan && !input.skipPlanConfirm) {
    return {
      phase: "awaiting_plan",
      plan: input.plan,
      pendingGate: "plan",
      summary: input.summary,
    };
  }
  return {
    phase: "idle",
    plan: input.plan,
    summary: input.summary,
  };
}

/** Suspend at plan gate after external plan generation. */
export function enterPlanGate(state: WikiRunShellState, plan: WikiRunPlan): WikiRunShellState {
  return transitionEnterPlanGate(state, plan);
}

/** Operator HITL resume for plan or publish gate. */
export function resumeGate(state: WikiRunShellState, input: ResumeGateInput): WikiRunShellState {
  return transitionResumeGate(state, input);
}

/** Enter produce phase (plan must already be approved / present). */
export function markProducing(state: WikiRunShellState): WikiRunShellState {
  return transitionMarkProducing(state);
}

/** Enter host hard-validate after produce. */
export function markHardValidate(
  state: WikiRunShellState,
  pages?: string[],
  summary?: string,
): WikiRunShellState {
  return transitionMarkHardValidate(state, pages, summary);
}

/** Suspend at publish gate. */
export function markAwaitingPublish(
  state: WikiRunShellState,
  pages?: string[],
  summary?: string,
): WikiRunShellState {
  return transitionMarkAwaitingPublish(state, pages, summary);
}

/** Terminal: published (approve or autoApprove after validate). */
export function markPublished(state: WikiRunShellState, summary?: string): WikiRunShellState {
  return transitionPublished(state, summary);
}

/** Terminal: publication declined. */
export function markPublicationDeclined(state: WikiRunShellState): WikiRunShellState {
  return transitionPublicationDeclined(state);
}

/** Terminal: failed. */
export function markFailed(state: WikiRunShellState, error: string): WikiRunShellState {
  return transitionFailed(state, error);
}

/** Terminal: cancelled. */
export function markCancelled(state: WikiRunShellState, summary?: string): WikiRunShellState {
  return transitionCancelled(state, summary);
}

/** Convenience: full happy-path phase labels for UI. */
export function shellPhaseLabel(phase: WikiRunShellPhase): string {
  switch (phase) {
    case "idle":
      return "Idle";
    case "awaiting_plan":
      return "Awaiting plan confirmation";
    case "producing":
      return "Producing wiki";
    case "hard_validate":
      return "Hard-validating";
    case "awaiting_publish":
      return "Awaiting publication";
    case "published":
      return "Published";
    case "publication_declined":
      return "Publication declined";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}
