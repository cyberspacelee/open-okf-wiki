/**
 * Pure WikiRunShell phase transitions (ADR 0030).
 * No Mastra / LLM — product owns plan → produce → hard-validate → publish.
 */

import { defaultWikiRunSpec, type WikiRunPlan } from "@okf-wiki/contract";
import type { ResumeGateInput, WikiRunGateKind } from "./gates.js";
import { assertValidResumeGate } from "./gates.js";

/** Product shell phases (Layer A). */
export type WikiRunShellPhase =
  | "idle"
  | "awaiting_plan"
  | "producing"
  | "hard_validate"
  | "awaiting_publish"
  | "published"
  | "publication_declined"
  | "failed"
  | "cancelled";

export type WikiRunShellState = {
  phase: WikiRunShellPhase;
  plan?: WikiRunPlan;
  pages?: string[];
  summary?: string;
  error?: string;
  /** Set while suspended at a HITL gate. */
  pendingGate?: WikiRunGateKind;
  /** Last plan-revision feedback (operator text). */
  revisionFeedback?: string;
};

const TERMINAL: ReadonlySet<WikiRunShellPhase> = new Set([
  "published",
  "publication_declined",
  "failed",
  "cancelled",
]);

export function isTerminalPhase(phase: WikiRunShellPhase): boolean {
  return TERMINAL.has(phase);
}

export function assertNotTerminal(state: WikiRunShellState): void {
  if (isTerminalPhase(state.phase)) {
    throw new Error(`shell already terminal: ${state.phase}`);
  }
}

function badTransition(from: WikiRunShellPhase, action: string, detail?: string): never {
  const suffix = detail ? ` (${detail})` : "";
  throw new Error(`invalid shell transition: ${from} + ${action}${suffix}`);
}

/** Apply operator plan-revision feedback onto a Spec. */
export function applyPlanRevision(
  prior: WikiRunPlan | undefined,
  feedback: string,
  workspaceName?: string,
): WikiRunPlan {
  const trimmed = feedback.trim();
  if (prior) {
    return {
      ...prior,
      notes: [prior.notes?.trim(), `Operator revision feedback:\n${trimmed}`]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 4000),
      changelog: [...(prior.changelog ?? []), "Operator requested Spec revision"].slice(-20),
    };
  }
  return {
    ...defaultWikiRunSpec(workspaceName ?? "Workspace"),
    summary: "Revised wiki plan",
    notes: `Operator revision feedback:\n${trimmed}`.slice(0, 4000),
    changelog: ["Operator requested Spec revision (no prior Spec)"],
  };
}

/** Enter plan gate with a generated Spec (after external plan produce). */
export function transitionEnterPlanGate(
  state: WikiRunShellState,
  plan: WikiRunPlan,
): WikiRunShellState {
  assertNotTerminal(state);
  if (state.phase !== "idle" && state.phase !== "awaiting_plan") {
    badTransition(state.phase, "enterPlanGate");
  }
  return {
    ...state,
    phase: "awaiting_plan",
    plan,
    pendingGate: "plan",
    revisionFeedback: undefined,
  };
}

/** Mark produce phase (after plan approved or skip-confirm). */
export function transitionMarkProducing(state: WikiRunShellState): WikiRunShellState {
  assertNotTerminal(state);
  if (state.phase === "producing") {
    return state;
  }
  // Allowed from idle (skip plan confirm) or after plan approve left idle with plan.
  if (state.phase !== "idle") {
    badTransition(state.phase, "markProducing");
  }
  if (!state.plan) {
    badTransition(state.phase, "markProducing", "plan required");
  }
  return {
    ...state,
    phase: "producing",
    pendingGate: undefined,
  };
}

/** Mark host hard-validate after produce completed. */
export function transitionMarkHardValidate(
  state: WikiRunShellState,
  pages?: string[],
  summary?: string,
): WikiRunShellState {
  assertNotTerminal(state);
  if (state.phase !== "producing" && state.phase !== "hard_validate") {
    badTransition(state.phase, "markHardValidate");
  }
  return {
    ...state,
    phase: "hard_validate",
    pages: pages ?? state.pages,
    summary: summary ?? state.summary,
    pendingGate: undefined,
  };
}

/** Suspend at publish gate after hard-validate passed. */
export function transitionMarkAwaitingPublish(
  state: WikiRunShellState,
  pages?: string[],
  summary?: string,
): WikiRunShellState {
  assertNotTerminal(state);
  if (state.phase !== "hard_validate" && state.phase !== "awaiting_publish") {
    badTransition(state.phase, "markAwaitingPublish");
  }
  const nextPages = pages ?? state.pages;
  if (!nextPages?.length) {
    badTransition(state.phase, "markAwaitingPublish", "pages required");
  }
  return {
    ...state,
    phase: "awaiting_publish",
    pages: nextPages,
    summary: summary ?? state.summary,
    pendingGate: "publish",
  };
}

/** Terminal: published. */
export function transitionPublished(state: WikiRunShellState, summary?: string): WikiRunShellState {
  assertNotTerminal(state);
  if (state.phase !== "awaiting_publish" && state.phase !== "hard_validate") {
    // hard_validate + autoApprove may skip awaiting_publish
    badTransition(state.phase, "published");
  }
  return {
    ...state,
    phase: "published",
    summary: summary ?? state.summary ?? "Published",
    pendingGate: undefined,
  };
}

/** Terminal: operator declined publication. */
export function transitionPublicationDeclined(state: WikiRunShellState): WikiRunShellState {
  assertNotTerminal(state);
  if (state.phase !== "awaiting_publish") {
    badTransition(state.phase, "publication_declined");
  }
  return {
    ...state,
    phase: "publication_declined",
    summary: state.summary ?? "Publication declined",
    pendingGate: undefined,
  };
}

/** Terminal: failed with error message. */
export function transitionFailed(state: WikiRunShellState, error: string): WikiRunShellState {
  if (isTerminalPhase(state.phase) && state.phase !== "failed") {
    badTransition(state.phase, "failed");
  }
  return {
    ...state,
    phase: "failed",
    error,
    pendingGate: undefined,
  };
}

/** Terminal: cancelled (plan deny or operator stop). */
export function transitionCancelled(state: WikiRunShellState, summary?: string): WikiRunShellState {
  if (isTerminalPhase(state.phase) && state.phase !== "cancelled") {
    badTransition(state.phase, "cancelled");
  }
  return {
    ...state,
    phase: "cancelled",
    summary: summary ?? state.summary ?? "Cancelled",
    pendingGate: undefined,
  };
}

/**
 * Apply a gate resume action.
 * Returns next state; plan revise stays on awaiting_plan with updated plan notes.
 */
export function transitionResumeGate(
  state: WikiRunShellState,
  input: ResumeGateInput,
): WikiRunShellState {
  assertValidResumeGate(input);
  assertNotTerminal(state);

  if (input.step === "plan") {
    if (state.phase !== "awaiting_plan" || state.pendingGate !== "plan") {
      badTransition(state.phase, `resumeGate(plan/${input.action})`);
    }

    if (input.action === "deny") {
      return transitionCancelled(state, "Plan declined by operator");
    }

    if (input.action === "revise") {
      const feedback = input.feedback!.trim();
      const plan = applyPlanRevision(input.plan ?? state.plan, feedback);
      return {
        ...state,
        phase: "awaiting_plan",
        plan,
        pendingGate: "plan",
        revisionFeedback: feedback,
      };
    }

    // approve
    const plan = input.plan ?? state.plan;
    if (!plan) {
      throw new Error("plan approval requires a plan payload");
    }
    return {
      ...state,
      phase: "idle",
      plan,
      pendingGate: undefined,
      revisionFeedback: undefined,
    };
  }

  // publish
  if (state.phase !== "awaiting_publish" || state.pendingGate !== "publish") {
    badTransition(state.phase, `resumeGate(publish/${input.action})`);
  }

  if (input.action === "deny") {
    return transitionPublicationDeclined(state);
  }

  // approve
  return transitionPublished(state, state.summary);
}
