import { z } from "zod";

export const WikiRunRecordStatusSchema = z.enum([
  "running",
  "published",
  "needs_input",
  "failed",
  "cancelled",
  "awaiting_plan",
  "awaiting_publication",
  "publication_declined",
]);

export type WikiRunRecordStatus = z.infer<typeof WikiRunRecordStatusSchema>;

/** Process exit codes for headless CLI (stable automation contract). */
export const WikiRunExitCode = {
  success: 0,
  failure: 1,
  needsInput: 2,
  awaitingPublication: 3,
  publicationDeclined: 4,
  cancelled: 5,
  awaitingPlan: 6,
} as const;

export type WikiRunExitCodeValue = (typeof WikiRunExitCode)[keyof typeof WikiRunExitCode];

export function exitCodeForStatus(status: WikiRunRecordStatus): WikiRunExitCodeValue {
  switch (status) {
    case "published":
      return WikiRunExitCode.success;
    case "needs_input":
      return WikiRunExitCode.needsInput;
    case "awaiting_publication":
      return WikiRunExitCode.awaitingPublication;
    case "publication_declined":
      return WikiRunExitCode.publicationDeclined;
    case "awaiting_plan":
      return WikiRunExitCode.awaitingPlan;
    case "cancelled":
      return WikiRunExitCode.cancelled;
    case "failed":
    case "running":
      return WikiRunExitCode.failure;
  }
}

/** Page template hints from the Producer Skill. */
export const WikiPageTemplateSchema = z.enum([
  "overview",
  "architecture",
  "module",
  "flow",
  "concept",
]);

export type WikiPageTemplate = z.infer<typeof WikiPageTemplateSchema>;

export const WikiRunSpecDomainSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  /** Source scope description (paths, boundaries, concerns). */
  scope: z.string().trim().min(1).max(2000),
  critical: z.boolean().default(true),
  questions: z.array(z.string().trim().min(1).max(500)).default([]),
});

export type WikiRunSpecDomain = z.infer<typeof WikiRunSpecDomainSchema>;

export const WikiRunSpecPageSchema = z.object({
  path: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(500),
  domainIds: z.array(z.string().trim().min(1)).default([]),
  questions: z.array(z.string().trim().min(1).max(500)).default([]),
  template: WikiPageTemplateSchema.optional(),
  critical: z.boolean().default(true),
});

export type WikiRunSpecPage = z.infer<typeof WikiRunSpecPageSchema>;

export const WikiRunSpecAcceptanceSchema = z.object({
  reviewRequired: z.boolean().default(true),
  maxRepairRounds: z.number().int().min(0).max(8).default(2),
  /** Severities that block publish when present after final review. */
  blockingSeverities: z.array(z.enum(["blocking", "major", "minor"])).default(["blocking"]),
});

export type WikiRunSpecAcceptance = z.infer<typeof WikiRunSpecAcceptanceSchema>;

/**
 * Living, executable Wiki Run specification (operator-facing + agent-facing).
 * Replaces the thin path/purpose plan: domains, questions, acceptance, replan trail.
 */
export const WikiRunSpecSchema = z.object({
  version: z.literal(1).default(1),
  summary: z.string().min(1).max(4000),
  audience: z.string().min(1).max(1000).default("Engineers and operators reading this repository"),
  domains: z.array(WikiRunSpecDomainSchema).default([]),
  pages: z.array(WikiRunSpecPageSchema).min(1),
  openQuestions: z.array(z.string().max(500)).default([]),
  acceptance: WikiRunSpecAcceptanceSchema.default(() => WikiRunSpecAcceptanceSchema.parse({})),
  /** Operator revision feedback and agent replan notes. */
  notes: z.string().max(4000).optional(),
  /** Chronological replan / discovery trail (stigmergy-lite). */
  changelog: z.array(z.string().max(500)).default([]),
});

export type WikiRunSpec = z.infer<typeof WikiRunSpecSchema>;

/**
 * @deprecated Use WikiRunSpec. Kept as a type alias during rename; same schema.
 */
export const WikiRunPlanSchema = WikiRunSpecSchema;
export type WikiRunPlan = WikiRunSpec;

export const DefectSeveritySchema = z.enum(["blocking", "major", "minor"]);
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

export const DefectItemSchema = z.object({
  severity: DefectSeveritySchema,
  code: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(200).optional(),
  issue: z.string().trim().min(1).max(2000),
  suggestedFix: z.string().trim().max(2000).optional(),
});

export type DefectItem = z.infer<typeof DefectItemSchema>;

export const DefectReportSchema = z.object({
  version: z.literal(1).default(1),
  reviewerId: z.string().min(1),
  clean: z.boolean(),
  defects: z.array(DefectItemSchema).default([]),
  summary: z.string().max(2000).optional(),
});

export type DefectReport = z.infer<typeof DefectReportSchema>;

export const MergedDefectReportSchema = z.object({
  version: z.literal(1).default(1),
  clean: z.boolean(),
  defects: z.array(DefectItemSchema).default([]),
  reviewerIds: z.array(z.string()).default([]),
  summary: z.string().max(4000).optional(),
});

export type MergedDefectReport = z.infer<typeof MergedDefectReportSchema>;

/**
 * Lightweight persisted run record for the Web UI / server registry.
 * Frozen skill fields + spec live on the record; orchestration is the
 * Mastra wiki-run workflow (thin shell + supervisor produce).
 */
export const StoredRunRecordSchema = z.object({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  status: WikiRunRecordStatusSchema,
  error: z.string().optional(),
  autoApprove: z.boolean().optional(),
  /** Absolute skill root frozen for this run (fork, home, or package). */
  skillPath: z.string().min(1).optional(),
  /** Content digest of the frozen Producer Skill. */
  skillDigest: z.string().min(1).optional(),
  /**
   * Proposed / living WikiRunSpec (plan-gate + produce).
   * Field name remains `plan` for Session/Run UI continuity; value is WikiRunSpec.
   */
  plan: WikiRunSpecSchema.optional(),
  /** Wiki-relative page paths produced under staging (when available). */
  pages: z.array(z.string().min(1)).optional(),
  /** Short operator-facing summary of the run outcome. */
  summary: z.string().optional(),
  /**
   * Operator Session that started or owns this run (Session-first linkage).
   * Headless / autoApprove API starts may omit this.
   */
  sessionId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type StoredRunRecord = z.infer<typeof StoredRunRecordSchema>;

/** Minimal default Spec used when parsing fails or fixtures need a seed. */
export function defaultWikiRunSpec(workspaceName: string): WikiRunSpec {
  return WikiRunSpecSchema.parse({
    summary: `Source-grounded wiki for ${workspaceName}`,
    audience: "Engineers and operators reading this repository",
    domains: [
      {
        id: "core",
        title: "Core",
        scope: "Repository entry points, layout, and primary modules",
        critical: true,
        questions: ["What is this repository for?", "What are the main runtime boundaries?"],
      },
    ],
    pages: [
      {
        path: "overview.md",
        purpose: "Repository purpose, audience, and navigation",
        domainIds: ["core"],
        questions: ["What is this repository for?"],
        template: "overview",
        critical: true,
      },
    ],
    openQuestions: [],
    acceptance: {
      reviewRequired: true,
      maxRepairRounds: 2,
      blockingSeverities: ["blocking"],
    },
    changelog: [],
  });
}
