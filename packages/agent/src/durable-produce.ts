/**
 * Optional durable produce path (Mastra DurableAgent, beta).
 *
 * Enable with OKF_WIKI_DURABLE_PRODUCE=1. When unset or construction fails,
 * callers use the normal Agent.stream path.
 *
 * Note: DurableAgent.stream returns a different result shape than Agent.stream;
 * this helper only reports whether durable is requested. Full durable produce
 * wiring (PubSub observe/reconnect) is a follow-up; product currently uses
 * normal Agent.stream + Host review/hard-validate for reliability.
 */

export function durableProduceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.OKF_WIKI_DURABLE_PRODUCE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Placeholder for future DurableAgent integration.
 * Always returns null today so produce uses Agent.stream; keeps the env flag
 * and module surface stable without type-fragile casts.
 */
export async function tryCreateDurableRoot(
  _agent: unknown,
): Promise<null> {
  if (!durableProduceEnabled()) {
    return null;
  }
  // DurableAgent.stream is not API-compatible with Agent.stream (different
  // result type). Keep flag documented; do not swap produce path until
  // workflow-ui projection supports DurableAgentStreamResult.
  return null;
}
