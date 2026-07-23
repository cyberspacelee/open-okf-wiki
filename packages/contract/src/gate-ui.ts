/**
 * Single product map: workflow suspend payload → operator gate chips/text.
 *
 * Session stream finalize and session reconcile must both call this — never
 * invent separate option lists (ADR 0027 / Phase 2 UI protocol convergence).
 * Pure domain: no I/O, no Mastra.
 */

import type { WikiRunPlan } from "./run.js";
import type { InteractionOption, PendingInteraction } from "./interaction.js";

/** Minimal suspend payload shape (plan-gate / publish-gate suspendSchema). */
export type SuspendPayloadForGate = {
  gate?: string;
  plan?: WikiRunPlan;
  pages?: string[];
  summary?: string;
};

/** Operator-facing gate UI derived from a suspend payload. */
export type GateUiMap = {
  gate: "plan" | "publication";
  pending: PendingInteraction;
  plan?: WikiRunPlan;
  text: string;
};

/** Plan-gate choice chips (single source of truth). */
export function optionsForPlanGate(plan: WikiRunPlan): InteractionOption[] {
  return [
    {
      id: "approve",
      label: `Write ${plan.pages.length} page(s)`,
      description: plan.pages.map((p) => p.path).join(", "),
    },
    {
      id: "revise",
      label: "Request changes",
      description: "Type modification feedback to replan",
    },
    {
      id: "deny",
      label: "Reject this plan",
      description: "Cancel this Wiki Run",
    },
  ];
}

/** Publish-gate choice chips (single source of truth). */
export function optionsForPublishGate(): InteractionOption[] {
  return [
    {
      id: "approve",
      label: "Publish staged wiki",
      description: "Atomic publication via product gate",
    },
    {
      id: "deny",
      label: "Keep staging only",
      description: "Do not change Published Wiki",
    },
  ];
}

/**
 * Map a workflow suspend payload to gate chips + operator text.
 * Returns null when the payload is not a known product gate.
 */
export function mapSuspendToGateUi(
  payload: SuspendPayloadForGate | null | undefined,
): GateUiMap | null {
  if (!payload || typeof payload.gate !== "string") {
    return null;
  }

  if (payload.gate === "plan" && payload.plan) {
    const plan = payload.plan;
    return {
      gate: "plan",
      plan,
      // Short prompt only — full plan lives in data-plan / workflow suspend.
      text:
        `A **wiki plan** with **${plan.pages.length}** page(s) is ready for review. ` +
        "Open the plan card (or fullscreen) below, then approve, request changes, or type revision feedback.",
      pending: {
        type: "approval",
        question:
          "How do you want to proceed with this plan? You can also type free-text revision feedback.",
        mode: "choice_or_input",
        selectionMode: "single",
        options: optionsForPlanGate(plan),
        inputPlaceholder:
          "Describe plan changes (e.g. add concepts.md, drop architecture.md)…",
      },
    };
  }

  if (payload.gate === "publication") {
    const pages = payload.pages ?? [];
    return {
      gate: "publication",
      text:
        `Staged **${pages.length}** page(s)` +
        (pages.length ? `:\n\n${pages.map((p) => `- \`${p}\``).join("\n")}` : "") +
        "\n\nChoose how to proceed:",
      pending: {
        type: "confirmation",
        question: "Publish the staged wiki?",
        mode: "choice_only",
        selectionMode: "single",
        options: optionsForPublishGate(),
      },
    };
  }

  return null;
}

/**
 * Build gate UI when only run status / plan / pages are known (reconcile restore).
 * Prefer mapSuspendToGateUi when a real suspend payload is available.
 */
export function mapRunGateToGateUi(input: {
  gate: "plan" | "publication";
  plan?: WikiRunPlan;
  pages?: string[] | null;
  summary?: string | null;
}): GateUiMap | null {
  if (input.gate === "plan") {
    if (!input.plan) {
      return null;
    }
    return mapSuspendToGateUi({ gate: "plan", plan: input.plan });
  }
  return mapSuspendToGateUi({
    gate: "publication",
    pages: input.pages ?? [],
    summary: input.summary ?? undefined,
  });
}
