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

/**
 * Stable product details carried inside Pi's real `wiki_produce` tool result.
 *
 * Pi's event owns toolCallId and lifecycle framing. `status` plus `summary`
 * express progress without a second phase field or a duplicate child tree.
 */
export const WikiProduceToolDetailsSchema = z
  .object({
    status: WikiProduceToolStatusSchema,
    runId: z.string().trim().min(1).optional(),
    spec: WikiRunSpecSchema.optional(),
    pages: z.array(z.string().trim().min(1).max(200)).optional(),
    summary: z.string().max(4000).optional(),
    defects: MergedDefectReportSchema.nullable().optional(),
  })
  .strict();

export type WikiProduceToolDetails = z.infer<typeof WikiProduceToolDetailsSchema>;
