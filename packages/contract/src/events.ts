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
 * AI-SDK-aligned tool part states (subset used by Session UI).
 * @see AI SDK UIMessage ToolUIPart states
 */
export const ToolPartStateSchema = z.enum([
  "input-streaming",
  "input-available",
  "output-available",
  "output-error",
]);

export type ToolPartState = z.infer<typeof ToolPartStateSchema>;

/**
 * Live operator stream event for the Session / Run console.
 * Includes coarse status events and AI-SDK-style parts (text / tool / subagent).
 */
export const RunSseEventSchema = z.object({
  type: z.enum(["status", "log", "error", "done", "text", "tool", "tool_result", "part"]),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  status: WikiRunRecordStatusSchema.optional(),
  message: z.string().optional(),
  /**
   * Optional part type for automation Run SSE (not Operator Session truth).
   * Prefer Pi tool names (`tool-read`, `tool-ls`) when present.
   */
  partType: z.string().max(128).optional(),
  /** Markdown/plain text for text parts (truncated). */
  text: z.string().max(8000).optional(),
  toolName: z.string().max(128).optional(),
  toolCallId: z.string().max(128).optional(),
  toolState: ToolPartStateSchema.optional(),
  /** Safe short summary of tool input (paths only, redacted). */
  inputSummary: z.string().max(500).optional(),
  /** Safe short summary of tool output. */
  outputSummary: z.string().max(500).optional(),
  /** Agent node: root | domain | leaf | reviewer */
  nodeId: z.string().max(64).optional(),
});

export type RunSseEvent = z.infer<typeof RunSseEventSchema>;

/** Statuses that end an SSE stream (run is no longer in progress). */
export const TERMINAL_RUN_STATUSES = [
  "published",
  "failed",
  "awaiting_plan",
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
