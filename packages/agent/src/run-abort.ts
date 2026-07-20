/**
 * Product-level AbortSignal binding for Wiki Runs.
 *
 * Server owns AbortControllers (registerRunAbortController / abortRun) and
 * passes the signal into agent entrypoints. Workflow steps look up the bound
 * signal by runId so runWikiAgent can stop mid-step (fixture delay / LLM stream).
 *
 * Mastra also provides a per-step abortSignal; callers should combine both.
 */

const boundSignals = new Map<string, AbortSignal>();

/** Bind a product cancel signal for the lifetime of a workflow invocation. */
export function bindRunAbortSignal(runId: string, signal: AbortSignal): void {
  boundSignals.set(runId, signal);
}

/** Active product cancel signal for `runId`, if any. */
export function getRunAbortSignal(runId: string): AbortSignal | undefined {
  return boundSignals.get(runId);
}

/** Drop the binding when the workflow invocation finishes. */
export function unbindRunAbortSignal(runId: string): void {
  boundSignals.delete(runId);
}

/** Combine zero-or-more abort signals (undefined when none). */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}

/** True when any of the signals is already aborted. */
export function isAnyAborted(
  ...signals: Array<AbortSignal | undefined>
): boolean {
  return signals.some((s) => Boolean(s?.aborted));
}
