/**
 * Host-enforced bounds for adaptive Wiki Runs (product policy, not model choice).
 * Depth is Root → Domain → Leaf (max 2 hops below Root).
 */
export const ADAPTIVE_RUN_LIMITS = {
  /** Max Domain→Leaf depth below Root (Root=0). */
  maxDepth: 2,
  /** Max concurrent Domain branches. */
  maxDomainFanOut: 4,
  /** Max Leaf tasks per Domain. */
  maxLeafFanOut: 6,
  /** Default maxSteps for Domain research agents. */
  domainMaxSteps: 12,
  /** Default maxSteps for Leaf research agents. */
  leafMaxSteps: 8,
  /** Default maxSteps for Reviewer. */
  reviewerMaxSteps: 8,
} as const;

export function adaptiveLimitsInstruction(): string {
  return [
    `Adaptive bounds (enforced by product policy): maxDepth=${ADAPTIVE_RUN_LIMITS.maxDepth},`,
    `maxDomainFanOut=${ADAPTIVE_RUN_LIMITS.maxDomainFanOut}, maxLeafFanOut=${ADAPTIVE_RUN_LIMITS.maxLeafFanOut}.`,
    "Prefer the fewest Domains that isolate independent evidence; do not open empty slots.",
  ].join(" ");
}
