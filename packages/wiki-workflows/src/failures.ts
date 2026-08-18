/** Current durable budget vocabulary; former DAG/node/snapshot codes have no compatibility path. */
export type WikiBudgetExhaustedCode =
  | "delegated_tasks_exhausted"
  | "delegate_batches_exhausted"
  | "session_turns_exhausted"
  | "session_tool_calls_exhausted";

/** Budget codes that block the run (not retryable agent attempts). */
export const WIKI_BUDGET_EXHAUSTED_CODES = [
  "delegated_tasks_exhausted",
  "delegate_batches_exhausted",
  "session_turns_exhausted",
  "session_tool_calls_exhausted",
] as const satisfies readonly WikiBudgetExhaustedCode[];

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

export function isWikiBudgetExhaustedCode(code: unknown): code is WikiBudgetExhaustedCode {
  return typeof code === "string" && (WIKI_BUDGET_EXHAUSTED_CODES as readonly string[]).includes(code);
}

/** True for WikiBudgetExhaustedError or duck-typed `{ code: budget… }`. */
export function isWikiBudgetExhaustedError(error: unknown): boolean {
  if (error instanceof WikiBudgetExhaustedError) return true;
  if (!error || typeof error !== "object") return false;
  return isWikiBudgetExhaustedCode((error as { code?: unknown }).code);
}

export function budgetExhaustedCode(error: unknown): WikiBudgetExhaustedCode {
  if (error instanceof WikiBudgetExhaustedError) return error.code;
  if (error && typeof error === "object" && isWikiBudgetExhaustedCode((error as { code?: unknown }).code)) {
    return (error as { code: WikiBudgetExhaustedCode }).code;
  }
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
