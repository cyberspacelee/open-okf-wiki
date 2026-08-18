import path from "node:path";
import type {
  WikiExecutionBudgets,
  WikiRunPause,
  WikiRunStage,
  WikiRunWarning,
} from "./producer-types.js";
import type { WikiProductionPlan } from "./runtime-types.js";

/** Publication and publication-finalization format. Run snapshots are format 2. */
export const WIKI_FORMAT = 1 as const;

export class UnsupportedWikiRunVersionError extends Error {
  constructor(readonly location: string, readonly found: unknown, readonly expected: number) {
    super(`Unsupported Wiki format at ${location}: expected ${expected}, found ${String(found)}. Preserve needed evidence, then delete stale .okf-wiki Run state. The Published Wiki is independent.`);
    this.name = "UnsupportedWikiRunVersionError";
  }
}

export interface WikiExecutionAuthority {
  attempt: number;
  executionToken: string;
}

export interface WikiExecutionOwner {
  pid: number;
}

export type WikiProductionTransition =
  | { kind: "started"; at: string }
  | { kind: "attempt_started"; at: string; executionToken: string; owner: WikiExecutionOwner }
  | { kind: "plan_pinned"; at: string; plan: WikiProductionPlan }
  | { kind: "stage_entered"; at: string; stage: WikiRunStage; budgets?: WikiExecutionBudgets }
  | { kind: "lead_completed"; at: string; summary: string }
  | { kind: "paused"; at: string; pause: WikiRunPause }
  | { kind: "interrupted" | "manual_paused"; at: string }
  | { kind: "resumed"; at: string; executionToken: string; owner: WikiExecutionOwner }
  | { kind: "cancelled"; at: string }
  | { kind: "failed"; at: string; error: string }
  | { kind: "warning"; at: string; warning: WikiRunWarning }
  | { kind: "published"; at: string; pages: string[]; sourceFingerprint: string; finalTreeDigest: string };

export function parseProductionPlan(value: unknown, runId: string): WikiProductionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki production plan: ${runId}`);
  const plan = value as Partial<WikiProductionPlan> & Record<string, unknown>;
  assertExactKeys(plan, ["sourcePlan", "candidateWikiRoot", "skillRoot", "skillTreeDigest", "language", "generation",
    "maxConcurrentAgents", "budgets", "models", "runSessionDirectory", "leadSessionFile", "leadSessionAttempt", "transientRetries",
    "sessionTimeoutMs", "baseRetryDelayMs", "prompt"], "Wiki production plan");
  const sourcePlan = parsePinnedSourcePlan(plan.sourcePlan, runId);
  if (!sourcePlan || typeof plan.candidateWikiRoot !== "string" || typeof plan.skillRoot !== "string" || !isDigest(plan.skillTreeDigest)
    || (plan.language !== "zh" && plan.language !== "en")
    || typeof plan.runSessionDirectory !== "string" || typeof plan.prompt !== "string"
    || !parseExecutionBudgets(plan.budgets) || !isRoleModels(plan.models) || !isGenerationProfile(plan.generation)
    || !Number.isInteger(plan.maxConcurrentAgents) || (plan.maxConcurrentAgents ?? 0) < 1
    || !Number.isInteger(plan.transientRetries) || (plan.transientRetries ?? -1) < 0
    || !Number.isFinite(plan.sessionTimeoutMs) || (plan.sessionTimeoutMs ?? 0) <= 0
    || !Number.isFinite(plan.baseRetryDelayMs) || (plan.baseRetryDelayMs ?? -1) < 0) {
    throw new Error(`Invalid Wiki production plan: ${runId}`);
  }
  const expectedRunRoot = path.join(sourcePlan.workspaceRoot, ".okf-wiki", "runs", runId);
  if (path.resolve(sourcePlan.workspaceRoot) !== sourcePlan.workspaceRoot
    || path.resolve(plan.candidateWikiRoot) !== path.join(expectedRunRoot, "candidate", "wiki")
    || path.resolve(plan.skillRoot) !== path.join(expectedRunRoot, "skill")
    || path.resolve(plan.runSessionDirectory) !== path.join(expectedRunRoot, "sessions")) {
    throw new Error(`Invalid Wiki production plan identity: ${runId}`);
  }
  return Object.freeze(structuredClone(plan as WikiProductionPlan));
}

function parsePinnedSourcePlan(value: unknown, runId: string): WikiProductionPlan["sourcePlan"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<WikiProductionPlan["sourcePlan"]> & Record<string, unknown>;
  assertExactKeys(raw, ["workspaceRoot", "workspaceRealPath", "configPath", "defaultSourceIgnores", "excludes", "sources", "fingerprint"], "Wiki pinned source plan");
  if (typeof raw.workspaceRoot !== "string" || typeof raw.workspaceRealPath !== "string" || typeof raw.configPath !== "string"
    || typeof raw.defaultSourceIgnores !== "boolean" || !isStringArray(raw.excludes) || !Array.isArray(raw.sources)
    || typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) return undefined;
  const scopes = new Set<string>();
  const sources = raw.sources.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki pinned source: ${runId}`);
    const source = value as Partial<WikiProductionPlan["sourcePlan"]["sources"][number]>;
    assertExactKeys(source as Record<string, unknown>, ["scopeId", "logicalPath", "absolutePath", "realPath", "repositoryRoot", "repositoryIdentity", "origin", "head", "dirtyFingerprint"], "Wiki pinned source");
    if (typeof source.scopeId !== "string" || !source.scopeId || scopes.has(source.scopeId)
      || typeof source.logicalPath !== "string" || typeof source.absolutePath !== "string" || typeof source.realPath !== "string"
      || typeof source.repositoryRoot !== "string" || typeof source.repositoryIdentity !== "string"
      || !isPinnedOrigin(source.origin)
      || typeof source.head !== "string" || typeof source.dirtyFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(source.repositoryIdentity) || !/^[a-f0-9]{64}$/.test(source.dirtyFingerprint)) {
      throw new Error(`Invalid Wiki pinned source: ${runId}`);
    }
    if (path.resolve(source.absolutePath) !== source.absolutePath || path.resolve(source.realPath) !== source.realPath
      || path.resolve(source.repositoryRoot) !== source.repositoryRoot) throw new Error(`Invalid Wiki pinned source paths: ${runId}`);
    scopes.add(source.scopeId);
    return structuredClone(source as WikiProductionPlan["sourcePlan"]["sources"][number]);
  });
  if (path.resolve(raw.workspaceRoot) !== raw.workspaceRoot || path.resolve(raw.workspaceRealPath) !== raw.workspaceRealPath
    || path.resolve(raw.configPath) !== raw.configPath) throw new Error(`Invalid Wiki pinned workspace paths: ${runId}`);
  return { ...structuredClone(raw as WikiProductionPlan["sourcePlan"]), sources };
}

function isPinnedOrigin(value: unknown): value is WikiProductionPlan["sourcePlan"]["sources"][number]["origin"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.type === "link") return Object.keys(raw).every((key) => ["type", "localPath"].includes(key)) && typeof raw.localPath === "string";
  return raw.type === "clone" && Object.keys(raw).every((key) => ["type", "remoteUrl", "ref"].includes(key))
    && typeof raw.remoteUrl === "string" && (raw.ref === undefined || typeof raw.ref === "string");
}

function parseExecutionBudgets(value: unknown): WikiExecutionBudgets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<WikiExecutionBudgets> & Record<string, unknown>;
  const fields = ["maxDelegatedTasks", "maxDelegateBatches", "maxTurnsPerSession", "maxToolCallsPerSession"] as const;
  if (Object.keys(raw).some((key) => !fields.includes(key as typeof fields[number]))) return undefined;
  if (fields.some((field) => !Number.isInteger(raw[field]) || (raw[field] ?? 0) < 1)) return undefined;
  return raw as WikiExecutionBudgets;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRoleModels(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const roles = new Set(["lead", "research", "write", "review"]);
  const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return Object.entries(value).every(([role, selected]) => {
    if (!roles.has(role) || !selected || typeof selected !== "object" || Array.isArray(selected)) return false;
    const raw = selected as Record<string, unknown>;
    return Object.keys(raw).every((key) => ["provider", "id", "thinkingLevel"].includes(key))
      && typeof raw.provider === "string" && raw.provider.length > 0 && typeof raw.id === "string" && raw.id.length > 0
      && (raw.thinkingLevel === undefined || thinking.has(String(raw.thinkingLevel)));
  });
}

function isGenerationProfile(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (!hasExactKeys(raw, ["audience", "purpose", "focus", "granularity", "templates", "review"])
    || !isStringArray(raw.audience) || typeof raw.purpose !== "string") return false;
  return stringArrayRecord(raw.focus, ["include", "exclude"])
    && stringArrayRecord(raw.granularity, ["preferChildPagesFor"])
    && stringArrayRecord(raw.templates, ["requiredSections"])
    && stringArrayRecord(raw.review, ["mustCover"]);
}

function stringArrayRecord(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return hasExactKeys(raw, fields) && fields.every((field) => isStringArray(raw[field]));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}
