/**
 * Product bounds for supervisor-tree Wiki Runs.
 * Prefer workspace.orchestration when present; these are fallbacks.
 * - domain/leaf/reviewer maxSteps: host-enforced via generate maxSteps
 * - maxDepth / fan-out: enforced via delegation hooks when possible
 */

import type { WorkspaceConfig, WorkspaceOrchestration } from "@okf-wiki/contract";

export const DEFAULT_ORCHESTRATION: WorkspaceOrchestration = {
  maxDepth: 2,
  maxDomainFanOut: 4,
  maxLeafFanOut: 6,
  rootMaxSteps: 96,
  domainMaxSteps: 12,
  leafMaxSteps: 8,
  reviewerMaxSteps: 8,
  planMaxSteps: 24,
  reviewCouncilSize: 1,
};

export function resolveOrchestration(workspace?: WorkspaceConfig | null): WorkspaceOrchestration {
  const o = workspace?.orchestration;
  if (!o) {
    return { ...DEFAULT_ORCHESTRATION };
  }
  return {
    maxDepth: o.maxDepth ?? DEFAULT_ORCHESTRATION.maxDepth,
    maxDomainFanOut: o.maxDomainFanOut ?? DEFAULT_ORCHESTRATION.maxDomainFanOut,
    maxLeafFanOut: o.maxLeafFanOut ?? DEFAULT_ORCHESTRATION.maxLeafFanOut,
    rootMaxSteps: o.rootMaxSteps ?? DEFAULT_ORCHESTRATION.rootMaxSteps,
    domainMaxSteps: o.domainMaxSteps ?? DEFAULT_ORCHESTRATION.domainMaxSteps,
    leafMaxSteps: o.leafMaxSteps ?? DEFAULT_ORCHESTRATION.leafMaxSteps,
    reviewerMaxSteps: o.reviewerMaxSteps ?? DEFAULT_ORCHESTRATION.reviewerMaxSteps,
    planMaxSteps: o.planMaxSteps ?? DEFAULT_ORCHESTRATION.planMaxSteps,
    reviewCouncilSize: o.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize,
  };
}

export function orchestrationLimitsInstruction(
  orch: WorkspaceOrchestration = DEFAULT_ORCHESTRATION,
): string {
  return [
    `Supervisor policy: maxDepth=${orch.maxDepth},`,
    `maxDomainFanOut=${orch.maxDomainFanOut}, maxLeafFanOut=${orch.maxLeafFanOut}`,
    `(Host-enforced via delegation hooks where possible).`,
    `Domain/Leaf/Reviewer tool steps are host-capped at`,
    `${orch.domainMaxSteps}/${orch.leafMaxSteps}/${orch.reviewerMaxSteps}.`,
    "Prefer the fewest Domains that isolate independent evidence; do not open empty slots.",
    "Replan the Spec when discovery changes page set; keep a changelog entry.",
    "Before finishing, run review council and repair blocking defects.",
  ].join(" ");
}
