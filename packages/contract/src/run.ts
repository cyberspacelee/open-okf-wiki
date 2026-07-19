import { z } from "zod";
import { ModelRefSchema, WorkspaceSourceSchema } from "./workspace.js";

export const WikiRunRecordStatusSchema = z.enum([
  "running",
  "published",
  "needs_input",
  "failed",
  "cancelled",
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
    case "cancelled":
      return WikiRunExitCode.cancelled;
    case "failed":
    case "running":
      return WikiRunExitCode.failure;
  }
}

export const CompleteSchema = z.object({
  kind: z.literal("complete"),
  pages: z.array(z.string().min(1)).min(1),
  summary: z.string().optional(),
});

export type Complete = z.infer<typeof CompleteSchema>;

export const NeedsInputSchema = z.object({
  kind: z.literal("needs_input"),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        prompt: z.string().min(1),
      }),
    )
    .min(1),
});

export type NeedsInput = z.infer<typeof NeedsInputSchema>;

export const WikiRunOutcomeSchema = z.discriminatedUnion("kind", [
  CompleteSchema,
  NeedsInputSchema,
]);

export type WikiRunOutcome = z.infer<typeof WikiRunOutcomeSchema>;

/**
 * Frozen inputs for one Wiki Run.
 * Built from Workspace config + optional CLI overrides; no framework types.
 */
export const WikiRunRequestSchema = z.object({
  workspaceId: z.string().min(1),
  sources: z.array(WorkspaceSourceSchema).min(1),
  model: ModelRefSchema,
  publicationPath: z.string().min(1),
  skillPath: z.string().min(1).optional(),
  adaptive: z.boolean().default(false),
  reviewer: z.boolean().default(false),
  autoApprovePublication: z.boolean().default(false),
  explicitAnswers: z.record(z.string(), z.string()).optional(),
  retainAnalysisScratch: z.boolean().default(false),
});

export type WikiRunRequest = z.infer<typeof WikiRunRequestSchema>;

export const WikiRunResultSchema = z.object({
  runId: z.string().min(1),
  status: WikiRunRecordStatusSchema,
  outcome: WikiRunOutcomeSchema.optional(),
  error: z.string().optional(),
  publicationPath: z.string().optional(),
});

export type WikiRunResult = z.infer<typeof WikiRunResultSchema>;

/**
 * Lightweight persisted run record for the Web UI / server registry.
 * Agent orchestration updates status asynchronously after create.
 */
export const StoredRunRecordSchema = z.object({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  status: WikiRunRecordStatusSchema,
  error: z.string().optional(),
  autoApprove: z.boolean().optional(),
  /** Wiki-relative page paths produced under staging (when available). */
  pages: z.array(z.string().min(1)).optional(),
  /** Short operator-facing summary of the run outcome. */
  summary: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type StoredRunRecord = z.infer<typeof StoredRunRecordSchema>;
