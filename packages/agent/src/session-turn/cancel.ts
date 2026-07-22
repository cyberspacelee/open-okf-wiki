/**
 * Single cancel classifier for SessionTurn, Produce (runWikiAgent), and
 * Run console (wiki-run). Prefer this over local isAbortError / isCancelError.
 */

/**
 * True when an error indicates product cancel / abort / plan declined.
 * Covers AbortError, TimeoutError, WikiRunCancelled, and message patterns used
 * by workflow steps and stream pipes.
 */
export function isRunCancelledError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    name === "WikiRunCancelled"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|AbortError|cancelled|plan declined|bailed/i.test(message);
}
