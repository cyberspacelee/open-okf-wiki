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
 * How a source was attached to the Workspace.
 * - path: operator linked an existing local checkout (may be outside rootPath)
 * - clone: product cloned a remote into the Workspace (under rootPath/sources/…)
 */
export const SourceOriginSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("path"),
  }),
  z.object({
    type: z.literal("clone"),
    remoteUrl: z.string().trim().min(1).max(2000),
    /** Optional ref requested at clone time (branch/tag/commit). */
    ref: z.string().trim().min(1).max(200).optional(),
    clonedAt: z.string().datetime(),
  }),
]);

export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

/**
 * One local Git working tree used as a Wiki source.
 * Path is always absolute after registration. May live inside or outside Workspace rootPath.
 */
export const WorkspaceSourceSchema = z.object({
  id: SourceIdSchema,
  /** Absolute filesystem path to a local Git checkout. */
  path: z.string().trim().min(1),
  applyDefaultIgnores: z.boolean().default(true),
  ignore: z.array(IgnorePatternSchema).default([]),
  /** Omitted on legacy records; treat as path-linked. */
  origin: SourceOriginSchema.optional(),
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
 * Language for generated Wiki page content (not the operator UI locale).
 * Default English; Chinese is Simplified Chinese prose.
 */
export const WikiLanguageSchema = z.enum(["en", "zh"]);

export type WikiLanguage = z.infer<typeof WikiLanguageSchema>;

/**
 * Optional operator ignore presets (never applied automatically).
 * Host expands these into additive user `ignore` patterns when selected in the UI.
 */
export const IGNORE_PRESETS: Readonly<
  Record<string, { label: string; patterns: readonly string[] }>
> = Object.freeze({
  "java-tests": Object.freeze({
    label: "Java tests",
    patterns: Object.freeze([
      "src/test/**",
      "**/src/test/**",
      "**/*Test.java",
      "**/*Tests.java",
      "**/*IT.java",
      "**/*ITCase.java",
    ]),
  }),
  "js-tests": Object.freeze({
    label: "JS/TS tests",
    patterns: Object.freeze([
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.test.js",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.spec.js",
      "**/__tests__/**",
      "**/__mocks__/**",
    ]),
  }),
  "python-tests": Object.freeze({
    label: "Python tests",
    patterns: Object.freeze([
      "tests/**",
      "**/tests/**",
      "test/**",
      "**/test/**",
      "**/test_*.py",
      "**/*_test.py",
    ]),
  }),
});

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
  /**
   * When true, interactive Wiki Runs pause for operator plan confirmation
   * before writing pages. Headless/autoApprove skips this gate.
   */
  planConfirm: z.boolean().default(false),
  /**
   * Output language for Wiki page body and titles produced by Wiki Runs.
   * Independent of the operator UI locale.
   */
  wikiLanguage: WikiLanguageSchema.default("en"),
  /**
   * Optional path to a project Producer Skill
   * (`{root}/.agents/skills/repository-wiki-producer`).
   * Omit to resolve home (`~/.agents/skills`) or package default.
   */
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
