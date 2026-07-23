/**
 * HITL interaction shapes for plan/publish gates (ADR 0031).
 * Not conversation history — Pi JSONL owns that.
 */

import { z } from "zod";

/** Choice option for interaction data parts. */
export const InteractionOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
});

export type InteractionOption = z.infer<typeof InteractionOptionSchema>;

/** How the UI collects the user's answer. */
export const InteractionModeSchema = z.enum([
  "choice_only",
  "input_only",
  "choice_or_input",
]);

export type InteractionMode = z.infer<typeof InteractionModeSchema>;

/**
 * Pending user interaction while a gate is open.
 * Options come from the product gate map — never hardcode labels in the client.
 */
export const PendingInteractionSchema = z.object({
  type: z.enum(["approval", "choice", "input", "confirmation"]),
  question: z.string().min(1).max(2000),
  mode: InteractionModeSchema.default("choice_or_input"),
  selectionMode: z.enum(["single", "multi"]).default("single"),
  options: z.array(InteractionOptionSchema).default([]),
  inputPlaceholder: z.string().max(200).optional(),
  toolCallId: z.string().optional(),
});

export type PendingInteraction = z.infer<typeof PendingInteractionSchema>;

/** Structured resume payload for a pending interaction. */
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
