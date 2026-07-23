import { z } from "zod";

/** OpenAI-compatible request shape used by enterprise gateways. */
export const ProviderApiShapeSchema = z.enum(["completions", "responses"]);

export type ProviderApiShape = z.infer<typeof ProviderApiShapeSchema>;

/**
 * Product provider kind (wire protocol family).
 * Only OpenAI-compatible gateways are supported today.
 */
export const ProviderKindSchema = z.enum(["openai-compatible"]);

export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** Extra HTTP headers (e.g. User-Agent for gateway WAF). */
export const ProviderHeadersSchema = z
  .record(z.string().min(1).max(128), z.string().max(2000))
  .optional();

export type ProviderHeaders = z.infer<typeof ProviderHeadersSchema>;

/**
 * One served model under a provider endpoint (OpenCode-style leaf).
 * Selection key is `id` (stable profile id referenced by Workspace.model.profileId).
 */
export const CatalogModelSchema = z.object({
  /** Stable selection id (workspace.profileId). Unique across all providers. */
  id: z.string().trim().min(1).max(64),
  /** Operator-facing label. */
  name: z.string().trim().min(1).max(120),
  /**
   * Served model identity on the wire (`openai/gpt-4o` or bare gateway id).
   * The `provider/` prefix is stripped before the request.
   */
  modelId: z.string().trim().min(1).max(200),
  maxContextTokens: z.number().int().positive().max(10_000_000).optional(),
  /** Optional per-model header overrides (merged over provider headers). */
  headers: ProviderHeadersSchema,
});

export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/**
 * One gateway / connection (OpenCode-style provider).
 * Credentials and baseUrl live here; many models hang off one provider.
 */
export const ProviderEntrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  kind: ProviderKindSchema.default("openai-compatible"),
  baseUrl: z.string().trim().default(""),
  /** Secret; never return raw value from HTTP APIs. */
  apiKey: z.string().default(""),
  apiShape: ProviderApiShapeSchema.default("completions"),
  /**
   * Connection-level headers (User-Agent, etc.).
   * Applied to Pi/OpenAI SDK requests for every model under this provider.
   */
  headers: ProviderHeadersSchema,
  /**
   * When true, Pi may send system prompts as OpenAI `developer` role
   * (reasoning models). Most third-party gateways reject it — default false.
   */
  supportsDeveloperRole: z.boolean().default(false),
  models: z.array(CatalogModelSchema).default([]),
});

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

/**
 * Flattened runtime view of one selectable model (provider fields denormalized).
 * Used by agent bridge, workspace resolution, and UI dropdowns.
 */
export const ModelProfileSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  providerKind: ProviderKindSchema.optional(),
  providerId: z.string().trim().min(1).max(64).optional(),
  modelId: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().default(""),
  apiKey: z.string().default(""),
  apiShape: ProviderApiShapeSchema.default("completions"),
  maxContextTokens: z.number().int().positive().max(10_000_000).optional(),
  headers: ProviderHeadersSchema,
  /** Inherited from parent provider (default false). */
  supportsDeveloperRole: z.boolean().optional(),
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * Machine-local provider catalog (version 3 — provider tree only).
 * Never embed this document (or apiKeys) in workspace.json or run events.
 */
export const ProviderConfigSchema = z.object({
  version: z.literal(3),
  defaultModelProfileId: z.string().trim().min(1).optional(),
  providers: z.array(ProviderEntrySchema).default([]),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Safe public view of one model (no raw secrets). */
export const ModelProfilePublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerKind: ProviderKindSchema,
  providerId: z.string().optional(),
  providerName: z.string().optional(),
  modelId: z.string(),
  baseUrl: z.string(),
  apiKeySet: z.boolean(),
  apiKeyMasked: z.string().nullable(),
  apiShape: ProviderApiShapeSchema,
  maxContextTokens: z.number().int().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  supportsDeveloperRole: z.boolean().optional(),
});

export type ModelProfilePublic = z.infer<typeof ModelProfilePublicSchema>;

/** Safe public view of one provider endpoint. */
export const ProviderEntryPublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: ProviderKindSchema,
  baseUrl: z.string(),
  apiKeySet: z.boolean(),
  apiKeyMasked: z.string().nullable(),
  apiShape: ProviderApiShapeSchema,
  headers: z.record(z.string(), z.string()).optional(),
  supportsDeveloperRole: z.boolean(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      modelId: z.string(),
      maxContextTokens: z.number().int().positive().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

export type ProviderEntryPublic = z.infer<typeof ProviderEntryPublicSchema>;

/** Safe public catalog for operator UI. */
export const ProviderPublicSchema = z.object({
  version: z.literal(3),
  models: z.array(ModelProfilePublicSchema),
  providers: z.array(ProviderEntryPublicSchema),
  defaultModelProfileId: z.string().optional(),
  envFallback: z.object({
    openaiBaseUrlSet: z.boolean(),
    openaiApiKeySet: z.boolean(),
  }),
});

export type ProviderPublic = z.infer<typeof ProviderPublicSchema>;

/**
 * Create / update a catalog model (may include provider connection fields).
 * When `providerId` is set, model is added/updated under that provider.
 */
export const ModelProfileWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  modelId: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().default(""),
  providerKind: ProviderKindSchema.optional(),
  providerId: z.string().trim().min(1).max(64).optional(),
  providerName: z.string().trim().min(1).max(120).optional(),
  apiKey: z.union([z.string(), z.null()]).optional(),
  apiShape: ProviderApiShapeSchema.default("completions"),
  id: z.string().trim().min(1).max(64).optional(),
  maxContextTokens: z.union([z.number().int().positive().max(10_000_000), z.null()]).optional(),
  headers: z.union([z.record(z.string(), z.string()), z.null()]).optional(),
  /** Provider-level; omit on update to keep. Default false on create. */
  supportsDeveloperRole: z.boolean().optional(),
});

export type ModelProfileWrite = z.infer<typeof ModelProfileWriteSchema>;

/** Create / update a provider endpoint (without replacing models). */
export const ProviderEntryWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().default(""),
  apiKey: z.union([z.string(), z.null()]).optional(),
  apiShape: ProviderApiShapeSchema.default("completions"),
  kind: ProviderKindSchema.optional(),
  id: z.string().trim().min(1).max(64).optional(),
  headers: z.union([z.record(z.string(), z.string()), z.null()]).optional(),
  supportsDeveloperRole: z.boolean().optional(),
});

export type ProviderEntryWrite = z.infer<typeof ProviderEntryWriteSchema>;

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  apiShape: ProviderApiShapeSchema,
  status: z.number().int().optional(),
  message: z.string(),
  latencyMs: z.number().nonnegative().optional(),
});

export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;
