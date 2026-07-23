/**
 * Operator Session chrome types (ADR 0031).
 *
 * Conversation truth is Pi JSONL under `.okf-wiki/pi-sessions/`.
 * This module only models session status + thin workflow chrome — not message history.
 * UIMessage / SessionMessage protocols were deleted (no migrator).
 */

import { z } from "zod";
import { WikiRunPlanSchema } from "./run.js";

/** Operator Session lifecycle (conversation workspace, not a single HTTP request). */
export const OperatorSessionStatusSchema = z.enum([
  "active",
  "waiting",
  "running",
  "completed",
  "failed",
]);

export type OperatorSessionStatus = z.infer<typeof OperatorSessionStatusSchema>;

/** Thin workflow chrome for the conversation (not Semantic Workflow resume graph). */
export const SessionWorkflowStateSchema = z.object({
  plan: WikiRunPlanSchema.optional(),
  linkedRunId: z.string().optional(),
  phase: z
    .enum(["idle", "planning", "awaiting_plan", "writing", "awaiting_publish", "done"])
    .default("idle"),
  notes: z.string().max(4000).optional(),
});

export type SessionWorkflowState = z.infer<typeof SessionWorkflowStateSchema>;

/**
 * Product phase strip values used on Operator Session chrome.
 * Aligns with product `run_phase` injects (subset may grow via agent-protocol).
 */
export const SessionPhaseSchema = SessionWorkflowStateSchema.shape.phase;

export type SessionPhase = z.infer<typeof SessionPhaseSchema>;
