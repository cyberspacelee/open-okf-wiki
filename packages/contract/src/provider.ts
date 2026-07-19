import { z } from "zod";

/** OpenAI-compatible request shape used by enterprise gateways. */
export const ProviderApiShapeSchema = z.enum(["completions", "responses"]);

export type ProviderApiShape = z.infer<typeof ProviderApiShapeSchema>;

/**
 * One named model entry in the machine-local Settings catalog.
 * Secrets stay here — never in workspace.json.
 */
export const ModelProfileSchema = z.object({
  /** Stable id referenced by Workspace.model.profileId. */
  id: z.string().trim().min(1).max(64),
  /** Operator-facing label in dropdowns. */
  name: z.string().trim().min(1).max(120),
  /**
   * Served model identity (Mastra form: `openai/my-served-model` or bare id).
   */
  modelId: z.string().trim().min(1).max(200),
  /** OpenAI-compatible base URL ending in /v1 (or gateway equivalent). */
  baseUrl: z.string().trim().default(""),
  /** Secret; never return raw value from HTTP APIs. */
  apiKey: z.string().default(""),
  apiShape: ProviderApiShapeSchema.default("completions"),
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * Machine-local provider catalog (version 2 — multi-model).
 * Never embed this document (or apiKeys) in workspace.json or run events.
 */
export const ProviderConfigSchema = z.object({
  version: z.literal(2).default(2),
  /** Preferred model when creating a workspace without an explicit selection. */
  defaultModelProfileId: z.string().trim().min(1).optional(),
  models: z.array(ModelProfileSchema).default([]),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Legacy v1 single-endpoint shape (migrated on load). */
export const ProviderConfigV1Schema = z.object({
  version: z.literal(1).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  apiShape: ProviderApiShapeSchema.optional(),
  defaultModelId: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type ProviderConfigV1 = z.infer<typeof ProviderConfigV1Schema>;

/** Safe public view of one model (no raw secrets). */
export const ModelProfilePublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelId: z.string(),
  baseUrl: z.string(),
  apiKeySet: z.boolean(),
  apiKeyMasked: z.string().nullable(),
  apiShape: ProviderApiShapeSchema,
});

export type ModelProfilePublic = z.infer<typeof ModelProfilePublicSchema>;

/** Safe public catalog for operator UI. */
export const ProviderPublicSchema = z.object({
  version: z.literal(2),
  models: z.array(ModelProfilePublicSchema),
  defaultModelProfileId: z.string().optional(),
  envFallback: z.object({
    openaiBaseUrlSet: z.boolean(),
    openaiApiKeySet: z.boolean(),
  }),
});

export type ProviderPublic = z.infer<typeof ProviderPublicSchema>;

/** Create / replace fields for a model profile (apiKey omit = keep on update). */
export const ModelProfileWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  modelId: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().default(""),
  /**
   * On create: required for live use (may be empty for draft).
   * On update: omit to keep, null/"" to clear.
   */
  apiKey: z.union([z.string(), z.null()]).optional(),
  apiShape: ProviderApiShapeSchema.default("completions"),
  /** Optional stable id on create; server generates otherwise. */
  id: z.string().trim().min(1).max(64).optional(),
});

export type ModelProfileWrite = z.infer<typeof ModelProfileWriteSchema>;

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  apiShape: ProviderApiShapeSchema,
  status: z.number().int().optional(),
  message: z.string(),
  latencyMs: z.number().nonnegative().optional(),
});

export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;
