/**
 * WikiRunShell gate types — plan / publish HITL (ADR 0030).
 * Pure types + validation; no framework imports.
 */

import type { WikiRunPlan } from "@okf-wiki/contract";

/** HITL gate kinds owned by the product shell. */
export type WikiRunGateKind = "plan" | "publish";

/**
 * Operator actions at a gate.
 * `revise` is only valid for the plan gate.
 */
export type WikiRunGateAction = "approve" | "deny" | "revise";

/** Resume payload for a suspended gate. */
export type ResumeGateInput = {
  /** Which gate is being answered. */
  step: WikiRunGateKind;
  action: WikiRunGateAction;
  /** Confirmed or edited plan (plan gate approve / revise). */
  plan?: WikiRunPlan;
  /** Free-text operator feedback when action is revise. */
  feedback?: string;
};

export function isWikiRunGateKind(value: string): value is WikiRunGateKind {
  return value === "plan" || value === "publish";
}

export function isWikiRunGateAction(value: string): value is WikiRunGateAction {
  return value === "approve" || value === "deny" || value === "revise";
}

/** Validate resume payload shape (throws on illegal combinations). */
export function assertValidResumeGate(input: ResumeGateInput): void {
  if (!isWikiRunGateKind(input.step)) {
    throw new Error(`unknown gate step: ${String(input.step)}`);
  }
  if (!isWikiRunGateAction(input.action)) {
    throw new Error(`unknown gate action: ${String(input.action)}`);
  }
  if (input.step === "publish" && input.action === "revise") {
    throw new Error("publish gate does not support revise");
  }
  if (input.action === "revise") {
    const feedback = input.feedback?.trim();
    if (!feedback) {
      throw new Error("plan revision requires feedback text");
    }
  }
  if (input.step === "plan" && input.action === "approve" && !input.plan) {
    // plan may already be on shell state; caller may omit when state has plan
  }
}
