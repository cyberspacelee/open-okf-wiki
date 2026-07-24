/**
 * Pi agent harness protocol (ADR 0030 / 0031).
 *
 * Operator conversation truth = Pi JSONL under `.okf-wiki/pi-sessions/`.
 * Product injects (thin strip only) = live SSE whitelist kinds; cold product
 * state from session meta + Run Record (no second body store).
 * Live transport = AgentSession commands + SSE (pi + whitelist product).
 *
 * No UIMessage history. No agent_span / body channel. No child_pi / okfAgent side path.
 * Produce child visibility lands on the parent Session as framework-shaped units
 * (tool result / parent-visible card / okf.produce_progress custom entry).
 *
 * `source:"pi"` events are opaque parent AgentSession events: the contract only
 * freezes envelope shape (`source`, `kind`, `sessionId`, optional `payload` /
 * `sequence` / `timestamp`). Kind strings and payload internals are owned by Pi;
 * product code must not invent parallel body channels beside this stream.
 */

import { z } from "zod";
import { WikiRunPlanSchema, WikiRunRecordStatusSchema } from "./run.js";

/** Relative dir under workspace meta: `{root}/.okf-wiki/pi-sessions/`. */
export const PI_SESSIONS_DIR = "pi-sessions" as const;

// ---------------------------------------------------------------------------
// Agent commands (client → server → AgentSession / WikiRunShell)
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

export const AgentStartWikiRunCommandSchema = z.object({
  type: z.literal("start_wiki_run"),
  /** Optional operator notes / kickoff override. */
  notes: z.string().max(4000).optional(),
  autoApprove: z.boolean().optional(),
  /**
   * Optional Settings model profile id for this run.
   * Overrides workspace.model / roleModels.writer for produce.
   * Credentials still come from the machine-local provider catalog.
   */
  modelProfileId: z.string().trim().min(1).max(64).optional(),
});

/**
 * Resume a product plan / publication gate (WikiRunShell).
 */
export const AgentResumeGateCommandSchema = z.object({
  type: z.literal("resume_gate"),
  gate: z.enum(["plan", "publication"]),
  action: z.enum(["approve", "deny", "revise"]),
  /** Required when action is revise (plan gate). */
  feedback: z.string().min(1).max(4000).optional(),
  /** Optional plan override when approving a plan gate. */
  plan: WikiRunPlanSchema.optional(),
  /** Linked product run id when already known. */
  runId: z.string().min(1).optional(),
});

export const AgentCommandSchema = z
  .discriminatedUnion("type", [
    AgentPromptCommandSchema,
    AgentSteerCommandSchema,
    AgentAbortCommandSchema,
    AgentCompactCommandSchema,
    AgentStartWikiRunCommandSchema,
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
export type AgentStartWikiRunCommand = z.infer<typeof AgentStartWikiRunCommandSchema>;
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
// Product SSE injects (server → client, beside Pi agent events)
// ADR 0031 whitelist only — thin strip; no body channel (no agent_span / work_unit).
// ---------------------------------------------------------------------------

/** Canonical product inject kinds (assert at emit boundaries). */
export const PRODUCT_INJECT_KINDS = [
  "run_link",
  "run_phase",
  "gate",
  "plan_progress",
  "defects",
] as const;

export type ProductInjectKind = (typeof PRODUCT_INJECT_KINDS)[number];

const PRODUCT_INJECT_KIND_SET = new Set<string>(PRODUCT_INJECT_KINDS);

/**
 * Hard allowlist for product SSE / trajectory rows.
 * Unknown kinds must not be emitted (tests fail; adapters should throw).
 */
export function assertProductInject(kind: string): asserts kind is ProductInjectKind {
  if (!PRODUCT_INJECT_KIND_SET.has(kind)) {
    throw new Error(
      `Product inject kind "${kind}" is not on the ADR 0031 whitelist ` +
        `(${PRODUCT_INJECT_KINDS.join(" | ")})`,
    );
  }
}

export function isProductInjectKind(kind: string): kind is ProductInjectKind {
  return PRODUCT_INJECT_KIND_SET.has(kind);
}

/** Wiki run phase strip for the operator timeline. */
export const ProductRunPhaseEventSchema = z.object({
  source: z.literal("product"),
  kind: z.literal("run_phase"),
  sessionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  phase: z.enum([
    "idle",
    "planning",
    "awaiting_plan",
    "writing",
    "awaiting_publish",
    "done",
    "failed",
    "cancelled",
  ]),
  status: WikiRunRecordStatusSchema.optional(),
  message: z.string().max(2000).optional(),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
});

/** HITL gate surface (plan / publication). */
export const ProductGateEventSchema = z.object({
  source: z.literal("product"),
  kind: z.literal("gate"),
  sessionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  gate: z.enum(["plan", "publication"]),
  /** Short operator prompt (not the full plan body). */
  question: z.string().max(2000).optional(),
  plan: WikiRunPlanSchema.optional(),
  pages: z.array(z.string()).optional(),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
});

/** Link a product Run Record to the Pi session. */
export const ProductRunLinkEventSchema = z.object({
  source: z.literal("product"),
  kind: z.literal("run_link"),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  status: WikiRunRecordStatusSchema.optional(),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
});

/** Spec page queue progress (Produce-owned; file-backed statuses). */
export const ProductPlanProgressEventSchema = z.object({
  source: z.literal("product"),
  kind: z.literal("plan_progress"),
  sessionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  pages: z
    .array(
      z.object({
        path: z.string().min(1).max(200),
        status: z.enum(["pending", "writing", "done"]),
      }),
    )
    .max(200)
    .default([]),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
});

/** Review council defects summary after a round. */
export const ProductDefectsEventSchema = z.object({
  source: z.literal("product"),
  kind: z.literal("defects"),
  sessionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  round: z.number().int().positive(),
  clean: z.boolean(),
  defectCount: z.number().int().nonnegative(),
  summary: z.string().max(2000).optional(),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
});

export const ProductSseEventSchema = z.discriminatedUnion("kind", [
  ProductRunPhaseEventSchema,
  ProductGateEventSchema,
  ProductRunLinkEventSchema,
  ProductPlanProgressEventSchema,
  ProductDefectsEventSchema,
]);

export type ProductRunPhaseEvent = z.infer<typeof ProductRunPhaseEventSchema>;
export type ProductGateEvent = z.infer<typeof ProductGateEventSchema>;
export type ProductRunLinkEvent = z.infer<typeof ProductRunLinkEventSchema>;
export type ProductPlanProgressEvent = z.infer<typeof ProductPlanProgressEventSchema>;
export type ProductDefectsEvent = z.infer<typeof ProductDefectsEventSchema>;
export type ProductSseEvent = z.infer<typeof ProductSseEventSchema>;

/** Server keepalive on the agent SSE stream (not a product inject). */
export const AgentSseHeartbeatSchema = z.object({
  source: z.literal("server"),
  kind: z.literal("heartbeat"),
  sessionId: z.string().min(1),
  timestamp: z.string().datetime(),
});

export type AgentSseHeartbeat = z.infer<typeof AgentSseHeartbeatSchema>;

/**
 * Envelope for the Pi agent SSE channel.
 * - `product` / `server` injects are fully typed here
 * - `pi` carries opaque parent AgentSession events only (no okfAgent side path).
 *   Shape: `{ source:"pi", kind, sessionId, payload?, sequence?, timestamp? }`.
 *   `kind` / `payload` are Pi-owned; do not re-type them as a product body channel.
 */
export const AgentSseEventSchema = z.union([
  ProductSseEventSchema,
  AgentSseHeartbeatSchema,
  z.object({
    source: z.literal("pi"),
    kind: z.string().min(1).max(64),
    sessionId: z.string().min(1),
    payload: z.unknown().optional(),
    sequence: z.number().int().nonnegative().optional(),
    timestamp: z.string().datetime().optional(),
  }),
]);

export type AgentSseEvent = z.infer<typeof AgentSseEventSchema>;

// ---------------------------------------------------------------------------
// Session list / create DTOs
// ---------------------------------------------------------------------------

export const PiSessionSummarySchema = z.object({
  id: z.string().min(1),
  /** Basename under pi-sessions (file or dir). */
  name: z.string().min(1),
  /**
   * Operator-facing title (from product meta).
   * Auto-filled from the first user prompt when still default.
   */
  title: z.string().min(1).max(200).optional(),
  /** ISO mtime when known. */
  updatedAt: z.string().datetime().optional(),
  /** True when only a placeholder file exists (AgentSession not yet live). */
  placeholder: z.boolean().default(false),
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
    path: z.string(),
    createdAt: z.string().datetime(),
    /** Live AgentSession not wired yet — commands are accepted as stubs. */
    stub: z.boolean(),
  }),
});

export type CreatePiAgentSessionResponse = z.infer<typeof CreatePiAgentSessionResponseSchema>;

export const AgentCommandResponseSchema = z.object({
  /**
   * `true` when the command was accepted and completed without a known failure.
   * `false` when the command ran but the agent/provider reported an error
   * (e.g. assistant stopReason "error") or dispatch failed.
   */
  ok: z.boolean(),
  sessionId: z.string().min(1),
  command: z.enum(["prompt", "steer", "abort", "compact", "start_wiki_run", "resume_gate"]),
  /**
   * `accepted` = validated and ran (or queued).
   * `stub` = AgentSession factory not ready; command parsed only.
   * `failed` = ran or attempted, but provider/agent reported failure.
   */
  status: z.enum(["accepted", "stub", "failed"]),
  message: z.string().optional(),
  runId: z.string().optional(),
});

export type AgentCommandResponse = z.infer<typeof AgentCommandResponseSchema>;
