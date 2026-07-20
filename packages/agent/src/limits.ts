/**
 * Product bounds for adaptive Wiki Runs.
 * - domainMaxSteps / leafMaxSteps / reviewerMaxSteps: host-enforced via generate maxSteps
 * - maxDepth / fan-out: instructional (Mastra free supervisor does not hard-cap fan-out yet)
 */
export const ADAPTIVE_RUN_LIMITS = {
  /** Max Domain→Leaf depth below Root (Root=0) — instructional for Root. */
  maxDepth: 2,
  /** Max concurrent Domain branches — instructional for Root. */
  maxDomainFanOut: 4,
  /** Max Leaf tasks per Domain — instructional for Root. */
  maxLeafFanOut: 6,
  /** Host-enforced maxSteps for Domain research generate/stream. */
  domainMaxSteps: 12,
  /** Host-enforced maxSteps for Leaf research generate/stream. */
  leafMaxSteps: 8,
  /** Host-enforced maxSteps for Reviewer generate. */
  reviewerMaxSteps: 8,
} as const;

export function adaptiveLimitsInstruction(): string {
  return [
    `Adaptive policy: maxDepth=${ADAPTIVE_RUN_LIMITS.maxDepth},`,
    `maxDomainFanOut=${ADAPTIVE_RUN_LIMITS.maxDomainFanOut}, maxLeafFanOut=${ADAPTIVE_RUN_LIMITS.maxLeafFanOut}`,
    `(instructional). Domain/Leaf/Reviewer tool steps are host-capped at`,
    `${ADAPTIVE_RUN_LIMITS.domainMaxSteps}/${ADAPTIVE_RUN_LIMITS.leafMaxSteps}/${ADAPTIVE_RUN_LIMITS.reviewerMaxSteps}.`,
    "Prefer the fewest Domains that isolate independent evidence; do not open empty slots.",
  ].join(" ");
}
