export type WikiBudgetExhaustedCode =
  | "session_turns_exhausted"
  | "session_tool_calls_exhausted";

export class WikiBudgetExhaustedError extends Error {
  readonly code: WikiBudgetExhaustedCode;
  readonly retryable = false;

  constructor(message: string, code: WikiBudgetExhaustedCode) {
    super(message);
    this.name = "WikiBudgetExhaustedError";
    this.code = code;
  }
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
