import { z } from "zod";
import { MergedDefectReportSchema, WikiRunSpecSchema } from "./run.js";

/** States exposed by the real Pi `wiki_produce` tool. */
export const WikiProduceToolStatusSchema = z.enum([
  "freezing",
  "planning",
  "awaiting_plan",
  "producing",
  "awaiting_publication",
  "published",
  "publication_declined",
  "failed",
  "cancelled",
]);

export type WikiProduceToolStatus = z.infer<typeof WikiProduceToolStatusSchema>;

/** Bounded display item from an in-process child session (not Operator Session history). */
export const WikiProduceChildItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().max(8000),
  }),
  z.object({
    type: z.literal("toolCall"),
    name: z.string().trim().min(1).max(120),
    argsSummary: z.string().max(500).optional(),
    status: z.enum(["running", "done", "error"]).optional(),
  }),
]);

export type WikiProduceChildItem = z.infer<typeof WikiProduceChildItemSchema>;

/**
 * Projection of one plan/domain/leaf/reviewer/root child for operator UI.
 * Lives only inside parent `wiki_produce` tool details (ADR 0032).
 */
export const WikiProduceChildSpanSchema = z.object({
  id: z.string().trim().min(1).max(200),
  role: z.enum(["plan", "domain", "leaf", "reviewer", "root_research", "root_write"]),
  status: z.enum(["running", "done", "error", "cancelled"]),
  summary: z.string().max(4000).optional(),
  items: z.array(WikiProduceChildItemSchema).max(50).optional(),
  usage: z
    .object({
      turns: z.number().int().nonnegative().optional(),
      contextTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type WikiProduceChildSpan = z.infer<typeof WikiProduceChildSpanSchema>;

/**
 * Stable product details carried inside Pi's real `wiki_produce` tool result.
 *
 * Pi's event owns toolCallId and lifecycle framing. `status` plus `summary`
 * express progress. Optional `children` is a parent-tool projection of
 * in-process child sessions — not Session messages and not a second SSE source.
 */
export const WikiProduceToolDetailsSchema = z
  .object({
    status: WikiProduceToolStatusSchema,
    runId: z.string().trim().min(1).optional(),
    spec: WikiRunSpecSchema.optional(),
    pages: z.array(z.string().trim().min(1).max(200)).optional(),
    summary: z.string().max(4000).optional(),
    defects: MergedDefectReportSchema.nullable().optional(),
    children: z.array(WikiProduceChildSpanSchema).max(32).optional(),
  })
  .strict();

export type WikiProduceToolDetails = z.infer<typeof WikiProduceToolDetailsSchema>;
