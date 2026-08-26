export type WikiBudgetExhaustedCode =
  | "session_turns_exhausted"
  | "session_tool_calls_exhausted"
  | "session_input_tokens_exhausted";

export class WikiBudgetExhaustedError extends Error {
  readonly code: WikiBudgetExhaustedCode;
  readonly retryable = false;

  constructor(message: string, code: WikiBudgetExhaustedCode) {
    super(message);
    this.name = "WikiBudgetExhaustedError";
    this.code = code;
  }
}

export class WikiSessionTimeoutError extends Error {
  readonly code = "session_timeout" as const;
  readonly retryable = false;

  constructor(timeoutMs: number) {
    super(`Wiki agent session timed out after ${timeoutMs}ms`);
    this.name = "WikiSessionTimeoutError";
  }
}

export class WikiCompletionError extends Error {
  readonly code: "completion_no_progress" | "completion_repair_exhausted";
  readonly retryable = false;

  constructor(message: string, code: WikiCompletionError["code"]) {
    super(message);
    this.name = "WikiCompletionError";
    this.code = code;
  }
}

export function failureCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "worker_error";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WikiValidationInfrastructureError extends Error {
  readonly code = "validator_infrastructure" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WikiValidationInfrastructureError";
  }
}
