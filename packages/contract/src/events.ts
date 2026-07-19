import { z } from "zod";
import { WikiRunRecordStatusSchema } from "./run.js";

/**
 * Operator-safe stream fragment for Web UI (no CoT, no tool args dumps).
 * Framework stream events adapt into this shape at the server boundary.
 */
export const StreamFragmentSchema = z.object({
  kind: z.enum(["text", "tool", "tool_result", "part", "other"]),
  text: z.string(),
});

export type StreamFragment = z.infer<typeof StreamFragmentSchema>;

/** Bounded allow-list style payload values for audit events. */
export const RunEventPayloadSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const RunEventSchema = z.object({
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  type: z.string().min(1).max(64),
  nodeId: z.string().default("root"),
  payload: RunEventPayloadSchema.default({}),
});

export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * Lightweight SSE progress event for the Run console.
 * Distinct from {@link RunEvent} (audit trail) — this is the live operator stream.
 */
export const RunSseEventSchema = z.object({
  type: z.enum(["status", "log", "error", "done"]),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  status: WikiRunRecordStatusSchema.optional(),
  message: z.string().optional(),
});

export type RunSseEvent = z.infer<typeof RunSseEventSchema>;

/** Statuses that end an SSE stream (run is no longer in progress). */
export const TERMINAL_RUN_STATUSES = [
  "published",
  "failed",
  "awaiting_publication",
  "publication_declined",
  "cancelled",
  "needs_input",
] as const satisfies readonly z.infer<typeof WikiRunRecordStatusSchema>[];

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalRunStatus(
  status: z.infer<typeof WikiRunRecordStatusSchema>,
): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** High-level card projection for the Run console sidebar. */
export const SessionCardSchema = z.object({
  level: z.enum(["info", "success", "warning", "error"]).default("info"),
  title: z.string(),
  body: z.string().optional(),
});

export type SessionCard = z.infer<typeof SessionCardSchema>;
