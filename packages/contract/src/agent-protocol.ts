/**
 * Pi Operator Session protocol (ADR 0030 / 0032).
 *
 * Pi JSONL and genuine AgentSession events are the sole conversation truth.
 * Wiki Runs start only through the real `wiki_produce` tool. The SSE seam has
 * no product inject, replay cursor, or sequence protocol.
 */

import { z } from "zod";
import { WikiRunSpecSchema } from "./run.js";
import { WikiProduceToolDetailsSchema } from "./wiki-produce.js";

/** Relative dir under workspace meta: `{root}/.okf-wiki/pi-sessions/`. */
export const PI_SESSIONS_DIR = "pi-sessions" as const;

// ---------------------------------------------------------------------------
// Agent commands (client → server → AgentSession / gate coordinator)
// ---------------------------------------------------------------------------

export const AgentPromptCommandSchema = z.object({
  type: z.literal("prompt"),
  text: z.string().min(1).max(100_000),
});

export const AgentSteerCommandSchema = z.object({
  type: z.literal("steer"),
  text: z.string().min(1).max(100_000),
});

export const AgentAbortCommandSchema = z.object({
  type: z.literal("abort"),
});

export const AgentCompactCommandSchema = z.object({
  type: z.literal("compact"),
});

/** Resume a plan or publication wait owned by the active `wiki_produce` tool. */
export const AgentResumeGateCommandSchema = z.object({
  type: z.literal("resume_gate"),
  gate: z.enum(["plan", "publication"]),
  action: z.enum(["approve", "deny", "revise"]),
  /** Required when action is revise (plan gate only). */
  feedback: z.string().min(1).max(4000).optional(),
  /** Optional Spec override when approving or revising a plan gate. */
  spec: WikiRunSpecSchema.optional(),
  /** Linked Wiki Run Record id. */
  runId: z.string().min(1).optional(),
});

export const AgentCommandSchema = z
  .discriminatedUnion("type", [
    AgentPromptCommandSchema,
    AgentSteerCommandSchema,
    AgentAbortCommandSchema,
    AgentCompactCommandSchema,
    AgentResumeGateCommandSchema,
  ])
  .superRefine((cmd, ctx) => {
    if (cmd.type === "resume_gate" && cmd.action === "revise") {
      if (!cmd.feedback?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "feedback is required when resume_gate action is revise",
          path: ["feedback"],
        });
      }
      if (cmd.gate === "publication") {
        ctx.addIssue({
          code: "custom",
          message: "revise is only valid for the plan gate",
          path: ["action"],
        });
      }
    }
  });

export type AgentPromptCommand = z.infer<typeof AgentPromptCommandSchema>;
export type AgentSteerCommand = z.infer<typeof AgentSteerCommandSchema>;
export type AgentAbortCommand = z.infer<typeof AgentAbortCommandSchema>;
export type AgentCompactCommand = z.infer<typeof AgentCompactCommandSchema>;
export type AgentResumeGateCommand = z.infer<typeof AgentResumeGateCommandSchema>;
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

/** Parse and validate an agent command body. Throws ZodError on failure. */
export function parseAgentCommand(input: unknown): AgentCommand {
  return AgentCommandSchema.parse(input);
}

/** Safe parse helper for HTTP adapters. */
export function safeParseAgentCommand(
  input: unknown,
): { success: true; data: AgentCommand } | { success: false; error: z.ZodError } {
  const result = AgentCommandSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ---------------------------------------------------------------------------
// Agent SSE (server → client)
// ---------------------------------------------------------------------------

/** Server keepalive on the AgentSession SSE stream. */
export const AgentSseHeartbeatSchema = z
  .object({
    source: z.literal("server"),
    kind: z.literal("heartbeat"),
    sessionId: z.string().min(1),
    timestamp: z.string().datetime(),
  })
  .strict();

export type AgentSseHeartbeat = z.infer<typeof AgentSseHeartbeatSchema>;

/** Current live Pi tool projection carried beside the durable SessionManager branch. */
export const AgentSseActiveToolSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1).max(100),
    details: WikiProduceToolDetailsSchema,
  })
  .strict();

export type AgentSseActiveTool = z.infer<typeof AgentSseActiveToolSchema>;

/** Current SessionManager branch plus genuine live tool state, sent first on SSE. */
export const AgentSseSnapshotSchema = z
  .object({
    source: z.literal("server"),
    kind: z.literal("snapshot"),
    sessionId: z.string().min(1),
    timestamp: z.string().datetime(),
    payload: z
      .object({
        session: z
          .object({
            id: z.string().min(1),
            workspaceId: z.string().min(1),
          })
          .strict(),
        /** Pi owns the durable message shape; Web projects it without re-persisting it. */
        messages: z.array(z.unknown()),
        /** Latest genuine Pi tool update; absent when no tool is live. */
        activeTool: AgentSseActiveToolSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type AgentSseSnapshot = z.infer<typeof AgentSseSnapshotSchema>;

/**
 * Opaque genuine parent AgentSession event.
 *
 * `kind` and `payload` remain Pi-owned. The product does not re-type Pi event
 * bodies or add an independent replay/sequence protocol around them.
 */
export const PiAgentSseEventSchema = z
  .object({
    source: z.literal("pi"),
    kind: z.string().min(1).max(64),
    sessionId: z.string().min(1),
    payload: z.unknown().optional(),
    timestamp: z.string().datetime().optional(),
  })
  .strict();

export type PiAgentSseEvent = z.infer<typeof PiAgentSseEventSchema>;

export const AgentSseEventSchema = z.union([
  AgentSseSnapshotSchema,
  PiAgentSseEventSchema,
  AgentSseHeartbeatSchema,
]);

export type AgentSseEvent = z.infer<typeof AgentSseEventSchema>;

// ---------------------------------------------------------------------------
// Session list / create DTOs
// ---------------------------------------------------------------------------

export const PiSessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  /** ISO mtime when known. */
  updatedAt: z.string().datetime().optional(),
});

export type PiSessionSummary = z.infer<typeof PiSessionSummarySchema>;

export const CreatePiAgentSessionBodySchema = z.object({
  /** Optional client-supplied id; server generates UUID when omitted. */
  sessionId: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(200).optional(),
});

export type CreatePiAgentSessionBody = z.infer<typeof CreatePiAgentSessionBodySchema>;

export const CreatePiAgentSessionResponseSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string(),
    createdAt: z.string().datetime(),
  }),
});

export type CreatePiAgentSessionResponse = z.infer<typeof CreatePiAgentSessionResponseSchema>;

export const AgentCommandResponseSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string().min(1),
  command: z.enum(["prompt", "steer", "abort", "compact", "resume_gate"]),
  status: z.enum(["accepted", "failed"]),
  message: z.string().optional(),
  runId: z.string().optional(),
});

export type AgentCommandResponse = z.infer<typeof AgentCommandResponseSchema>;
