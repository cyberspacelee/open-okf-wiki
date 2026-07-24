/**
 * Product bounds for supervisor-tree Wiki Runs.
 * Prefer workspace.orchestration when present; these are fallbacks.
 *
 * Fan-out / depth / council size are enforced in produce orchestration.
 * Pi AgentSession has no maxSteps API — turn limits use abort/timeout only.
 */

import type { WorkspaceConfig, WorkspaceOrchestration } from "@okf-wiki/contract";

export const DEFAULT_ORCHESTRATION: WorkspaceOrchestration = {
  maxDepth: 2,
  maxDomainFanOut: 4,
  maxLeafFanOut: 6,
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
    reviewCouncilSize: o.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize,
  };
}
