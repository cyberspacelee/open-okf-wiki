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

/** Choice option for interaction data parts. */
export const InteractionOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
});

export type InteractionOption = z.infer<typeof InteractionOptionSchema>;

/** How the UI collects the user's answer (product rule; options still agent-generated). */
export const InteractionModeSchema = z.enum([
  "choice_only",
  "input_only",
  "choice_or_input",
]);

export type InteractionMode = z.infer<typeof InteractionModeSchema>;

/**
 * Pending user interaction while Session is `waiting`.
 * Options come from the agent tool call — never hardcode labels in the client.
 */
export const PendingInteractionSchema = z.object({
  type: z.enum(["approval", "choice", "input", "confirmation"]),
  question: z.string().min(1).max(2000),
  /** Explicit UI mode; defaults derived if omitted for older records. */
  mode: InteractionModeSchema.default("choice_or_input"),
  /** v1: single only (multi-select deferred). */
  selectionMode: z.enum(["single", "multi"]).default("single"),
  options: z.array(InteractionOptionSchema).default([]),
  inputPlaceholder: z.string().max(200).optional(),
  /** Correlates with toolCallId when using client tool interaction. */
  toolCallId: z.string().optional(),
});

/** Structured resume payload for a pending interaction (primary protocol). */
export const InteractionResumeSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("choice"),
    selectedIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    channel: z.literal("input"),
    text: z.string().min(1).max(4000),
  }),
]);

export type InteractionResume = z.infer<typeof InteractionResumeSchema>;

export type PendingInteraction = z.infer<typeof PendingInteractionSchema>;

/** Durable workflow-ish state for the conversation (not Semantic Workflow resume graph). */
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
 * One conversation message in AI SDK UIMessage-compatible shape.
 * `parts` is the source of truth for rendering (text / tool / data).
 */
export const SessionMessagePartSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
    state: z.enum(["streaming", "done"]).optional(),
  }),
  z.object({
    type: z.string().regex(/^tool-/),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    state: z
      .enum([
        "input-streaming",
        "input-available",
        "output-available",
        "output-error",
        "approval-requested",
        "approval-responded",
      ])
      .optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    errorText: z.string().optional(),
  }),
  z.object({
    type: z.string().regex(/^data-/),
    id: z.string().optional(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal("step-start"),
  }),
]);

export type SessionMessagePart = z.infer<typeof SessionMessagePartSchema>;

export const SessionMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(SessionMessagePartSchema).min(1),
  createdAt: z.string().datetime().optional(),
});

export type SessionMessage = z.infer<typeof SessionMessageSchema>;

export const OperatorSessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1).max(200).default("Wiki Session"),
  status: OperatorSessionStatusSchema.default("active"),
  messages: z.array(SessionMessageSchema).default([]),
  workflow: SessionWorkflowStateSchema.default(() =>
    SessionWorkflowStateSchema.parse({}),
  ),
  pending: PendingInteractionSchema.nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type OperatorSession = z.infer<typeof OperatorSessionSchema>;
