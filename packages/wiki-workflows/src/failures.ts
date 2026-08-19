import type { WikiDelegateError, WikiTaskFailureCode } from "./delegate-contracts.js";

/** Current durable budget vocabulary; former DAG/node/snapshot codes have no compatibility path. */
export type WikiBudgetExhaustedCode =
  | "delegated_tasks_exhausted"
  | "delegate_batches_exhausted"
  | "session_turns_exhausted"
  | "session_tool_calls_exhausted";

/**
 * Thrown when the research round ceiling is hit.
 * Classification keys off `code`, never message text.
 */
export class WikiBudgetExhaustedError extends Error {
  readonly code: WikiBudgetExhaustedCode;
  readonly retryable = false;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: WikiBudgetExhaustedCode,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WikiBudgetExhaustedError";
    this.code = code;
    this.details = details;
  }

}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for WikiBudgetExhaustedError. */
export function isWikiBudgetExhaustedError(error: unknown): error is WikiBudgetExhaustedError {
  return error instanceof WikiBudgetExhaustedError;
}

export function budgetExhaustedCode(error: unknown): WikiBudgetExhaustedCode {
  if (error instanceof WikiBudgetExhaustedError) return error.code;
  throw new Error("Wiki budget error has no recognized code");
}

/**
 * Thrown when wiki validation cannot run because of infrastructure (missing
 * roots, unsafe tree IO setup, etc.), not because page content is invalid.
 * Callers should map this to `validator_infrastructure`, not content issues.
 */
export class WikiValidationInfrastructureError extends Error {
  readonly code = "validator_infrastructure" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WikiValidationInfrastructureError";
  }
}

export type WikiAttemptTerminal =
  | { action: "pause"; failure: WikiDelegateError }
  | { action: "fail"; failure: WikiDelegateError };

/** Terminal classification after Pi returns. Wiki does not retry provider errors with a fresh session. */
export function decideWikiAgentTerminal(error: unknown, aborted = false): WikiAttemptTerminal {
  const failure = classifyWikiAttemptFailure(error, aborted);
  if (failure.code === "quota" || failure.code === "usage_limit") return { action: "pause", failure };
  return { action: "fail", failure };
}

export function classifyWikiAttemptFailure(error: unknown, aborted = false): WikiDelegateError {
  if (aborted) return classified("cancelled", errorMessage(error), false);
  if (isWikiBudgetExhaustedError(error)) return classified(budgetExhaustedCode(error), errorMessage(error), false);
  const typed = taskExecutionError(error);
  if (typed?.code) return classified(typed.code, typed.message, false, typed.retryAfterMs);
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; statusCode?: unknown; retryAfterMs?: unknown } : {};
  const status = numberValue(value.status) ?? numberValue(value.statusCode);
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const retryAfterMs = numberValue(value.retryAfterMs);
  if (status === 429) return classified("rate_limit", errorMessage(error), false, retryAfterMs);
  if (status === 401) return classified("unauthorized", errorMessage(error), false);
  if (status === 403) return classified("forbidden", errorMessage(error), false);
  if (status !== undefined && status >= 500 && status <= 504) return classified("server_error", errorMessage(error), false);
  if (["econnreset", "etimedout", "eai_again"].includes(code)) return classified("network_reset", errorMessage(error), false);
  const message = errorMessage(error);
  if (/usage limit|quota exceeded|insufficient[_ -]?quota|billing|credit balance/i.test(message)) {
    const failureCode: WikiTaskFailureCode = /billing|credit balance/i.test(message)
      ? "billing" : /usage limit/i.test(message) ? "usage_limit" : "quota";
    return classified(failureCode, message, false, retryAfterMs);
  }
  if (/\b429\b|too many requests|rate limit/i.test(message)) return classified("rate_limit", message, false, retryAfterMs);
  if (/\b50[0-4]\b|internal server error|service unavailable|bad gateway|gateway timeout/i.test(message)) return classified("server_error", message, false);
  if (/econnreset|socket hang up|connection reset/i.test(message)) return classified("network_reset", message, false);
  if (/context (?:window|length)|context.*exhaust|overflow|compaction failed|range of input length should be|4(?:00|13)\s*(?:status code)?\s*\(no body\)/i.test(message)) {
    return classified("context_exhausted", message, false);
  }
  if (/timed? out|timeout/i.test(message)) return classified("timeout", message, false);
  if (/\b401\b|unauthorized|invalid api key/i.test(message)) return classified("unauthorized", message, false);
  if (/\b403\b|forbidden/i.test(message)) return classified("forbidden", message, false);
  if (status === 400 || /\b400\b|bad request/i.test(message)) return classified("server_error", message, false, retryAfterMs);
  if (/invalid request|schema|validation/i.test(message)) return classified(/schema|validation/i.test(message) ? "schema" : "invalid_request", message, false);
  return classified("unknown", message, false);
}

function taskExecutionError(error: unknown): { code?: WikiTaskFailureCode; message: string; retryAfterMs?: number } | undefined {
  if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "WikiTaskExecutionError") return undefined;
  const value = error as { code?: WikiTaskFailureCode; message?: unknown; options?: { retryAfterMs?: number } };
  return { code: value.code, message: typeof value.message === "string" ? value.message : String(error), retryAfterMs: value.options?.retryAfterMs };
}

function classified(code: WikiTaskFailureCode, message: string, retryable: boolean, retryAfterMs?: number): WikiDelegateError {
  return { code, message, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
