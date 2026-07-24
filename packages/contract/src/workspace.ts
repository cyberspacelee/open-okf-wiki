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
  /**
   * How the source was attached. Always set on write.
   * Legacy on-disk records without origin normalize to `{ type: "path" }` on parse
   * so freeze/run keep working; subsequent save persists the default.
   */
  origin: SourceOriginSchema.default({ type: "path" }),
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
  /**
   * Operational context budget for Wiki Run message compaction (tokens).
   * Not the provider hard window — that lives on the model profile as
   * `maxContextTokens`. When unset, the agent derives a target from
   * profile maxContextTokens × 0.85 when available.
   */
  contextTargetTokens: z.number().int().positive().max(10_000_000).optional(),
  inputTokensLimit: z.number().int().positive().optional(),
  outputTokensLimit: z.number().int().positive().optional(),
  totalTokensLimit: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
});

export type WorkspaceLimits = z.infer<typeof WorkspaceLimitsSchema>;

/**
 * Role → model mapping for planner/worker economics (Cursor-style hybrid).
 * When a role is omitted, the agent falls back to workspace.model.
 */
export const WorkspaceRoleModelsSchema = z.object({
  /** Root planner / synthesis / hard repairs. */
  planner: ModelRefSchema.optional(),
  /** Domain / Leaf research workers (prefer cheaper/faster). */
  worker: ModelRefSchema.optional(),
  /** Optional dedicated page writer; defaults to planner. */
  writer: ModelRefSchema.optional(),
  /**
   * Independent reviewer model(s). Multiple entries enable a decorrelated council.
   * Empty → fall back to workspace.model for a single reviewer.
   */
  reviewers: z.array(ModelRefSchema).max(4).default([]),
});

export type WorkspaceRoleModels = z.infer<typeof WorkspaceRoleModelsSchema>;

/**
 * Supervisor-tree budgets: fan-out/depth/council enforced by produce orchestration.
 * There is no per-role maxSteps API on Pi AgentSession; turn budgets are abort/timeout only.
 * Unknown legacy keys (e.g. rootMaxSteps) are stripped on parse.
 */
export const WorkspaceOrchestrationSchema = z.object({
  maxDepth: z.number().int().min(1).max(4).default(2),
  maxDomainFanOut: z.number().int().min(1).max(16).default(4),
  maxLeafFanOut: z.number().int().min(1).max(16).default(6),
  /**
   * Independent review council size (Host-owned).
   * Default 1 for cost/latency; set 2+ for decorrelated multi-lens review
   * (pad with same model + different prompts when only one reviewer model).
   */
  reviewCouncilSize: z.number().int().min(1).max(4).default(1),
});

export type WorkspaceOrchestration = z.infer<typeof WorkspaceOrchestrationSchema>;

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
  /**
   * Optional per-role models (planner / worker / reviewers).
   * Omitted roles use `model`.
   */
  roleModels: WorkspaceRoleModelsSchema.default(() => WorkspaceRoleModelsSchema.parse({})),
  /** Supervisor tree fan-out, depth, and review council size. */
  orchestration: WorkspaceOrchestrationSchema.default(() => WorkspaceOrchestrationSchema.parse({})),
  /**
   * When true, interactive Wiki Runs pause for operator Spec confirmation
   * before produce. Headless/autoApprove skips this gate.
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

/**
 * App-index list row (not the full WorkspaceConfig document).
 * Shared by API, Web, and core listWorkspaceSummaries. Outbound only.
 */
export type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt?: string;
  sourceCount: number;
};

/** Result of probing a local Git path (no network). Outbound only. */
export type GitProbe = {
  path: string;
  isGit: boolean;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  error: string | null;
};
