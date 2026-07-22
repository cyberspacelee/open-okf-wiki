/**
 * Host-enforced maxSteps budgets for plan / write Produce phases.
 */

import type { WikiRunPlan, WorkspaceConfig } from "@okf-wiki/contract";
import { resolveOrchestration } from "../limits.js";
import type { WikiRunAgentPhase } from "./types.js";

/** Default tool-step budget for plan phase (overridden by orchestration.planMaxSteps). */
export const DEFAULT_PLAN_MAX_STEPS = 24;
/** Base tool-step budget for write/produce phase (before plan page scaling). */
export const DEFAULT_WRITE_MAX_STEPS_BASE = 48;
/** Extra write steps per planned page. */
export const WRITE_MAX_STEPS_PER_PLAN_PAGE = 6;
/** Hard ceiling for write maxSteps. */
export const WRITE_MAX_STEPS_CAP = 120;

/** Resolve host-enforced maxSteps for a Wiki Run phase. */
export function resolvePhaseMaxSteps(
  workspace: WorkspaceConfig,
  phase: WikiRunAgentPhase,
  plan?: WikiRunPlan,
): number {
  if (workspace.limits?.maxSteps && workspace.limits.maxSteps > 0) {
    return workspace.limits.maxSteps;
  }
  const orch = resolveOrchestration(workspace);
  if (phase === "plan") {
    return orch.planMaxSteps || DEFAULT_PLAN_MAX_STEPS;
  }
  const pageCount = plan?.pages?.length ?? 0;
  return Math.min(
    Math.max(orch.rootMaxSteps, WRITE_MAX_STEPS_CAP),
    DEFAULT_WRITE_MAX_STEPS_BASE + pageCount * WRITE_MAX_STEPS_PER_PLAN_PAGE,
  );
}
