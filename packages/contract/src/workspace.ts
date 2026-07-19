import { z } from "zod";

/** Repository-relative POSIX-style ignore globs (product contract; not OS paths). */
export const IgnorePatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (pattern) =>
      !pattern.includes("\\") &&
      !pattern.includes("\0") &&
      !pattern.startsWith("/") &&
      !pattern.split("/").some((part) => part === "" || part === "." || part === ".."),
    { message: "ignore patterns must be repository-relative POSIX globs" },
  );

export const SourceIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "source id must be a lowercase slug");

/**
 * One local Git working tree used as a Wiki source.
 * Product never clones/fetches; path must already exist on disk.
 */
export const WorkspaceSourceSchema = z.object({
  id: SourceIdSchema,
  /** Absolute filesystem path to an existing local Git checkout. */
  path: z.string().trim().min(1),
  applyDefaultIgnores: z.boolean().default(true),
  ignore: z.array(IgnorePatternSchema).default([]),
});

export type WorkspaceSource = z.infer<typeof WorkspaceSourceSchema>;

/**
 * Workspace model selection.
 * Credentials and base URL live in Settings model profiles only.
 * `id` is a denormalized modelId for display; `profileId` is the catalog key.
 */
export const ModelRefSchema = z.object({
  /**
   * Served model identity (denormalized from the selected profile), e.g.
   * `openai/my-served-model`. Kept so overview still renders if the profile
   * was deleted.
   */
  id: z.string().trim().min(1),
  /** Reference to a machine-local Settings model profile. */
  profileId: z.string().trim().min(1).optional(),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

export const WorkspaceLimitsSchema = z.object({
  requestTimeoutSeconds: z.number().positive().default(120),
  contextTargetTokens: z.number().int().positive().optional(),
  inputTokensLimit: z.number().int().positive().optional(),
  outputTokensLimit: z.number().int().positive().optional(),
  totalTokensLimit: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
});

export type WorkspaceLimits = z.infer<typeof WorkspaceLimitsSchema>;

/**
 * Operator project (Workspace). Distinct from run-local analysis scratch.
 * Secrets must never appear in this document.
 */
export const WorkspaceConfigSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  /** Absolute path to the workspace root directory. */
  rootPath: z.string().trim().min(1),
  /** Empty until the operator adds at least one local Git source. */
  sources: z.array(WorkspaceSourceSchema).default([]),
  model: ModelRefSchema,
  /** Absolute path for the Published Wiki tree (same-volume rules apply at prepare). */
  publicationPath: z.string().trim().min(1),
  limits: WorkspaceLimitsSchema.default(() => WorkspaceLimitsSchema.parse({})),
  adaptive: z.boolean().default(false),
  reviewer: z.boolean().default(false),
  /** Optional path to a Skill fork directory; omit for bundled skill. */
  skillPath: z.string().trim().min(1).optional(),
  createdAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime().optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/** Result of probing a local Git path (no network). */
export const GitProbeSchema = z.object({
  path: z.string(),
  isGit: z.boolean(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  error: z.string().nullable(),
});

export type GitProbe = z.infer<typeof GitProbeSchema>;
