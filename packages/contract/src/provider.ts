import { z } from "zod";

/** OpenAI-compatible request shape used by enterprise gateways. */
export const ProviderApiShapeSchema = z.enum(["completions", "responses"]);

export type ProviderApiShape = z.infer<typeof ProviderApiShapeSchema>;

/**
 * Product provider kind (wire protocol family).
 * Only OpenAI-compatible gateways are supported; kept as a single-value
 * literal for wire/docs stability, not multi-provider selection.
 */
export const OPENAI_COMPATIBLE_PROVIDER_KIND = "openai-compatible" as const;

export const ProviderKindSchema = z.literal(OPENAI_COMPATIBLE_PROVIDER_KIND);

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
  kind: ProviderKindSchema.default(OPENAI_COMPATIBLE_PROVIDER_KIND),
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
  providerKind: ProviderKindSchema.default(OPENAI_COMPATIBLE_PROVIDER_KIND),
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

/** Safe public view of one model (no raw secrets). Outbound HTTP DTO only. */
export type ModelProfilePublic = {
  id: string;
  name: string;
  providerKind: ProviderKind;
  providerId?: string;
  providerName?: string;
  modelId: string;
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  apiShape: ProviderApiShape;
  maxContextTokens?: number;
  headers?: Record<string, string>;
  supportsDeveloperRole?: boolean;
};

/** Safe public view of one provider endpoint. Outbound HTTP DTO only. */
export type ProviderEntryPublic = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  apiShape: ProviderApiShape;
  headers?: Record<string, string>;
  supportsDeveloperRole: boolean;
  models: Array<{
    id: string;
    name: string;
    modelId: string;
    maxContextTokens?: number;
    headers?: Record<string, string>;
  }>;
};

/** Safe public catalog for operator UI. Outbound HTTP DTO only. */
export type ProviderPublic = {
  version: 3;
  models: ModelProfilePublic[];
  providers: ProviderEntryPublic[];
  defaultModelProfileId?: string;
  envFallback: {
    openaiBaseUrlSet: boolean;
    openaiApiKeySet: boolean;
  };
};

/**
 * Create / update a catalog model (may include provider connection fields).
 * When `providerId` is set, model is added/updated under that provider.
 */
export const ModelProfileWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  modelId: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().default(""),
  /**
   * Ignored on write — product only supports OpenAI-compatible gateways.
   * Accepted for older clients; always stored as openai-compatible.
   */
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
  /**
   * Ignored on write — product only supports OpenAI-compatible gateways.
   * Accepted for older clients; always stored as openai-compatible.
   */
  kind: ProviderKindSchema.optional(),
  id: z.string().trim().min(1).max(64).optional(),
  headers: z.union([z.record(z.string(), z.string()), z.null()]).optional(),
  supportsDeveloperRole: z.boolean().optional(),
});

export type ProviderEntryWrite = z.infer<typeof ProviderEntryWriteSchema>;

/** Outbound provider probe result — typed only. */
export type ProviderTestResult = {
  ok: boolean;
  apiShape: ProviderApiShape;
  status?: number;
  message: string;
  latencyMs?: number;
};
