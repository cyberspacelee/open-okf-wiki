import { z } from "zod";

export const WikiRunRecordStatusSchema = z.enum([
  "running",
  "published",
  "needs_input",
  "failed",
  "cancelled",
  "awaiting_plan",
  "awaiting_publication",
  "publication_declined",
]);

export type WikiRunRecordStatus = z.infer<typeof WikiRunRecordStatusSchema>;

/** Process exit codes for headless CLI (stable automation contract). */
export const WikiRunExitCode = {
  success: 0,
  failure: 1,
  needsInput: 2,
  awaitingPublication: 3,
  publicationDeclined: 4,
  cancelled: 5,
  awaitingPlan: 6,
} as const;

export type WikiRunExitCodeValue = (typeof WikiRunExitCode)[keyof typeof WikiRunExitCode];

export function exitCodeForStatus(status: WikiRunRecordStatus): WikiRunExitCodeValue {
  switch (status) {
    case "published":
      return WikiRunExitCode.success;
    case "needs_input":
      return WikiRunExitCode.needsInput;
    case "awaiting_publication":
      return WikiRunExitCode.awaitingPublication;
    case "publication_declined":
      return WikiRunExitCode.publicationDeclined;
    case "awaiting_plan":
      return WikiRunExitCode.awaitingPlan;
    case "cancelled":
      return WikiRunExitCode.cancelled;
    case "failed":
    case "running":
      return WikiRunExitCode.failure;
  }
}

/**
 * Lightweight persisted run record for the Web UI / server registry.
 * Frozen skill fields + plan live on the record; orchestration is the
 * Mastra wiki-run workflow (not a parallel WikiRunRequest DTO).
 */
/** Intended page set proposed during plan-confirm (operator-facing). */
export const WikiRunPlanSchema = z.object({
  summary: z.string().min(1).max(4000),
  pages: z
    .array(
      z.object({
        path: z.string().min(1),
        purpose: z.string().min(1).max(500),
      }),
    )
    .min(1),
  notes: z.string().max(4000).optional(),
});

export type WikiRunPlan = z.infer<typeof WikiRunPlanSchema>;

export const StoredRunRecordSchema = z.object({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  status: WikiRunRecordStatusSchema,
  error: z.string().optional(),
  autoApprove: z.boolean().optional(),
  /** Absolute skill root frozen for this run (bundled or fork). */
  skillPath: z.string().min(1).optional(),
  /** Content digest of the frozen Producer Skill. */
  skillDigest: z.string().min(1).optional(),
  /** Proposed page plan when planConfirm is active. */
  plan: WikiRunPlanSchema.optional(),
  /** Wiki-relative page paths produced under staging (when available). */
  pages: z.array(z.string().min(1)).optional(),
  /** Short operator-facing summary of the run outcome. */
  summary: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type StoredRunRecord = z.infer<typeof StoredRunRecordSchema>;
