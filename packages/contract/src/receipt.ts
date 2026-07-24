import { z } from "zod";

export const ReceiptStatusSchema = z.enum(["complete", "partial", "failed", "cancelled"]);

export const ReceiptEvidenceSchema = z.object({
  repositoryId: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  contentSha256: z.string().optional(),
});

/**
 * Bounded analysis receipt (control plane returns a short handoff; body on disk).
 * Cap enforcement is core's job; schema only describes shape.
 */
export const AnalysisReceiptSchema = z.object({
  version: z.literal(1).default(1),
  runId: z.string(),
  nodeId: z.string(),
  parentId: z.string().nullable(),
  attempt: z.number().int().positive(),
  status: ReceiptStatusSchema,
  scope: z.string(),
  sourceRevision: z.string().nullable().optional(),
  summary: z.string().default(""),
  findings: z.array(z.string()).default([]),
  evidence: z.array(ReceiptEvidenceSchema).default([]),
  childReceipts: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type AnalysisReceipt = z.infer<typeof AnalysisReceiptSchema>;
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;
