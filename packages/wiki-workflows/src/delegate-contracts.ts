import { MAX_WIKI_RESEARCH_ARTIFACT_BYTES, type WikiArtifactKind, type WikiArtifactRef } from "./artifact-store.js";
import { createHash } from "node:crypto";
import type { WikiBudgetExhaustedCode } from "./failures.js";
import { isSafeWikiPagePath, isWikiTaxonomySlug } from "./lead/path.js";
import { sameStringSet, stableStringify } from "./util.js";
import type { WikiAgentOutcome } from "./producer-types.js";

export interface WikiReviewFinding {
  id: string;
  path: string;
  severity: "critical" | "major" | "minor";
}

export interface WikiReviewResult {
  verdict: "pass" | "changes_requested";
  reviewedPaths: string[];
  findings: WikiReviewFinding[];
  profileCoverage: string[];
}

export const WIKI_FOLLOWUP_KINDS = [
  "unread_scope", "evidence_gap", "conflict", "taxonomy_uncertain", "tool_failure",
] as const;
export type WikiFollowupKind = typeof WIKI_FOLLOWUP_KINDS[number];

export interface WikiResearchFollowupDraft {
  kind: WikiFollowupKind;
  question: string;
  sourceScopeIds: string[];
}

export interface WikiDelegateFollowup extends WikiResearchFollowupDraft {
  id: string;
}

export interface WikiResearchDomainDraft {
  id: string;
  conceptIds: string[];
}

export interface WikiResearchDomain {
  sourceScopeId: string;
  domainId: string;
  conceptIds: string[];
}

export interface WikiResearchSignal {
  status: "complete" | "incomplete";
  summary: string;
  needsFollowup: boolean;
  followups: WikiResearchFollowupDraft[];
  domains: WikiResearchDomainDraft[];
}

export interface WikiResearchCompletion {
  status: "complete" | "incomplete";
  summary: string;
  needsFollowup: boolean;
  followups: WikiResearchFollowupDraft[];
  completedAssignmentIds: string[];
  domains: WikiResearchDomain[];
}

export function parseWikiResearchSignal(value: unknown): WikiResearchSignal {
  const raw = record(value, "Wiki research signal");
  exactKeys(raw, ["status", "summary", "needsFollowup", "followups", "domains"], "Wiki research signal");
  if (raw.status !== "complete" && raw.status !== "incomplete") throw new Error("Invalid Wiki research completion status");
  const summary = nonEmpty(raw.summary, "Wiki research completion summary");
  if (Buffer.byteLength(summary, "utf8") > 1024) throw new Error("Wiki research completion summary exceeds 1024 bytes");
  if (typeof raw.needsFollowup !== "boolean") throw new Error("Invalid Wiki research needsFollowup");
  const followups = parseResearchFollowups(raw.followups);
  if (raw.needsFollowup !== (followups.length > 0)) throw new Error("Wiki research needsFollowup must match followups");
  if (raw.status === "incomplete" && !raw.needsFollowup) throw new Error("Incomplete Wiki research requires followups");
  if (raw.status === "complete" && followups.length > 0) throw new Error("Complete Wiki research requires empty followups");
  const domains = parseResearchDomainDrafts(raw.domains);
  if (raw.status === "complete" && domains.length === 0) throw new Error("Complete Wiki research requires domains");
  return { status: raw.status, summary, needsFollowup: raw.needsFollowup, followups, domains };
}

/** Add host-owned assignment coverage and Source identity after an agent has submitted its signal. */
export function createWikiResearchCompletion(
  signal: WikiResearchSignal,
  assignmentIds: readonly string[],
  sourceScopeId: string,
): WikiResearchCompletion {
  const scope = nonEmpty(sourceScopeId, "Wiki research sourceScopeId");
  return {
    status: signal.status,
    summary: signal.summary,
    needsFollowup: signal.needsFollowup,
    followups: structuredClone(signal.followups),
    completedAssignmentIds: signal.status === "complete" ? [...assignmentIds] : [],
    domains: bindResearchDomains(signal.domains, scope),
  };
}

/** Parse the durable shape when reading persisted/internal completion data. */
export function parseWikiResearchCompletion(value: unknown): WikiResearchCompletion {
  const raw = record(value, "Wiki research completion");
  exactKeys(raw, ["status", "summary", "completedAssignmentIds", "needsFollowup", "followups", "domains"], "Wiki research completion");
  const domains = parseResearchDomains(raw.domains);
  const signal = parseWikiResearchSignal({
    status: raw.status,
    summary: raw.summary,
    needsFollowup: raw.needsFollowup,
    followups: raw.followups,
    domains: domains.map((domain) => ({ id: domain.domainId, conceptIds: domain.conceptIds })),
  });
  const completedAssignmentIds = strings(raw.completedAssignmentIds, "Wiki research completedAssignmentIds");
  if (new Set(completedAssignmentIds).size !== completedAssignmentIds.length) throw new Error("Wiki research completedAssignmentIds must be unique");
  return {
    status: signal.status,
    summary: signal.summary,
    needsFollowup: signal.needsFollowup,
    followups: signal.followups,
    completedAssignmentIds,
    domains,
  };
}

function bindResearchDomains(drafts: readonly WikiResearchDomainDraft[], sourceScopeId: string): WikiResearchDomain[] {
  return drafts.map((draft) => ({ sourceScopeId, domainId: draft.id, conceptIds: [...draft.conceptIds] }));
}

function parseResearchDomainDrafts(value: unknown): WikiResearchDomainDraft[] {
  if (!Array.isArray(value)) throw new Error("Invalid Wiki research domains");
  const domains = value.map((item, index) => {
    const raw = record(item, `Wiki research domain ${index + 1}`);
    exactKeys(raw, ["id", "conceptIds"], `Wiki research domain ${index + 1}`);
    const id = nonEmpty(raw.id, "Wiki research domain id");
    if (!isWikiTaxonomySlug(id)) throw new Error(`Wiki research domain id must be a lowercase ASCII slug: ${id}`);
    const conceptIds = strings(raw.conceptIds, "Wiki research domain conceptIds");
    if (conceptIds.some((conceptId) => !isWikiTaxonomySlug(conceptId))) throw new Error("Wiki research conceptIds must be lowercase ASCII slugs");
    if (new Set(conceptIds).size !== conceptIds.length) throw new Error("Wiki research conceptIds must be unique");
    return { id, conceptIds };
  });
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length) throw new Error("Wiki research domain ids must be unique");
  return domains;
}

function parseResearchDomains(value: unknown): WikiResearchDomain[] {
  if (!Array.isArray(value)) throw new Error("Invalid Wiki research domains");
  const domains = value.map((item, index) => {
    const raw = record(item, `Wiki research domain ${index + 1}`);
    exactKeys(raw, ["sourceScopeId", "domainId", "conceptIds"], `Wiki research domain ${index + 1}`);
    const sourceScopeId = nonEmpty(raw.sourceScopeId, "Wiki research domain sourceScopeId");
    const domainId = nonEmpty(raw.domainId, "Wiki research domain id");
    if (!isWikiTaxonomySlug(domainId)) throw new Error(`Wiki research domain id must be a lowercase ASCII slug: ${domainId}`);
    const conceptIds = strings(raw.conceptIds, "Wiki research domain conceptIds");
    if (conceptIds.some((conceptId) => !isWikiTaxonomySlug(conceptId))) throw new Error("Wiki research conceptIds must be lowercase ASCII slugs");
    if (new Set(conceptIds).size !== conceptIds.length) throw new Error("Wiki research conceptIds must be unique");
    return { sourceScopeId, domainId, conceptIds };
  });
  if (new Set(domains.map((domain) => `${domain.sourceScopeId}/${domain.domainId}`)).size !== domains.length) {
    throw new Error("Wiki research domains must be unique per source");
  }
  return domains;
}

export function parseWikiReviewResult(value: unknown): WikiReviewResult {
  const review = record(value, "Wiki review result");
  exactKeys(review, ["verdict", "reviewedPaths", "findings", "profileCoverage"], "Wiki review result");
  if (review.verdict !== "pass" && review.verdict !== "changes_requested") throw new Error("Invalid Wiki review verdict");
  const reviewedPaths = strings(review.reviewedPaths, "Wiki review reviewedPaths");
  if (!Array.isArray(review.findings)) throw new Error("Invalid review result findings");
  const findings: WikiReviewFinding[] = review.findings.map((value) => {
    const finding = record(value, "Wiki review finding");
    exactKeys(finding, ["id", "path", "severity"], "Wiki review finding");
    if (finding.severity !== "critical" && finding.severity !== "major" && finding.severity !== "minor") throw new Error("Invalid Wiki review finding severity");
    return {
      id: safeId(finding.id, "Wiki review finding id"),
      severity: finding.severity,
      path: nonEmpty(finding.path, "Wiki review finding path"),
    };
  });
  const profileCoverage = strings(review.profileCoverage, "Wiki review profileCoverage");
  if (reviewedPaths.some((page) => !safeAssignedWikiPath(page)) || new Set(reviewedPaths).size !== reviewedPaths.length) throw new Error("Invalid Wiki review reviewedPaths");
  if (findings.some((finding) => !reviewedPaths.includes(finding.path)) || new Set(findings.map((finding) => finding.id)).size !== findings.length) throw new Error("Wiki review finding path or id is invalid");
  return { verdict: review.verdict, reviewedPaths, findings, profileCoverage };
}

export type WikiDelegateRole = "research" | "write" | "review";

interface WikiDelegateTaskBase {
  id: string;
  instruction: string;
  sourceScopeIds: string[];
  contextRefs: string[];
}

export type WikiDelegateTask =
  | WikiDelegateTaskBase & {
    role: "research";
    mode: "discovery" | "supplement";
    assignmentIds: string[];
    domainScopeIds: string[];
    lensScopeIds: string[];
    resolvesIds: string[];
    writePaths?: never;
    reviewPaths?: never;
  }
  | WikiDelegateTaskBase & { role: "write"; writePaths: string[]; reviewPaths?: never }
  | WikiDelegateTaskBase & { role: "review"; reviewPaths: string[]; writePaths?: never };

export interface WikiReviewBasis {
  version: 1;
  candidateRevision: number;
  treeDigest: string;
  policyDigest: string;
  paths: string[];
}

export type WikiDelegateContract = WikiDelegateTask & {
  contractVersion: 2;
  contractId: string;
  contractDigest: string;
  batchId: number;
  reviewBasis?: WikiReviewBasis;
};

/** The only constructor for durable delegate contracts. */
export function createWikiDelegateContract(
  batchId: number,
  value: unknown,
  reviewBasis?: WikiReviewBasis,
): WikiDelegateContract {
  const task = parseWikiDelegateTask(value);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new Error("Invalid Wiki delegate contract batch");
  const basis = reviewBasis === undefined ? undefined : parseWikiReviewBasis(reviewBasis);
  if ((task.role === "review") !== Boolean(basis)) throw new Error("Only review delegate contracts require a review basis");
  if (basis && !sameStringSet(basis.paths, task.reviewPaths ?? [])) {
    throw new Error("Wiki review basis paths must exactly match the assigned review paths");
  }
  const body = {
    ...task,
    contractVersion: 2 as const,
    contractId: `b${batchId}-${task.id}`,
    batchId,
    ...(basis ? { reviewBasis: basis } : {}),
  };
  return parseWikiDelegateContract({ ...body, contractDigest: hashContract(body) });
}

export type WikiDelegateStatus = "complete" | "incomplete" | "failed";

export interface WikiDelegateGap {
  question: string;
  sourceScopeIds?: string[];
}

export interface WikiDelegateError {
  code: WikiTaskFailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface WikiDelegateReceipt {
  id: string;
  role: WikiDelegateRole;
  status: WikiDelegateStatus;
  summary: string;
  outputs: WikiArtifactRef[];
  completedAssignmentIds?: string[];
  needsFollowup?: boolean;
  followups?: WikiDelegateFollowup[];
  domains?: WikiResearchDomain[];
  coverage?: string[];
  gaps?: WikiDelegateGap[];
  error?: WikiDelegateError;
  attempts: number;
  review?: WikiReviewResult;
  contractId: string;
  contractDigest: string;
}

export interface WikiDelegateBatchSnapshot {
  batchId: number;
  status: "running" | "complete" | "partial" | "failed";
  receipts: WikiDelegateReceipt[];
  pendingTaskIds: string[];
}

export type WikiTaskFailureCode =
  | "rate_limit"
  | "quota"
  | "usage_limit"
  | "server_error"
  | "network_reset"
  | "timeout"
  | "context_exhausted"
  | "unauthorized"
  | "forbidden"
  | "billing"
  | "invalid_request"
  | "schema"
  | "artifact_io"
  | "cancelled"
  | "unknown"
  | WikiBudgetExhaustedCode;

export class WikiTaskExecutionError extends Error {
  constructor(
    message: string,
    readonly code?: WikiTaskFailureCode,
    readonly options: {
      retryAfterMs?: number;
      partialMarkdown?: string;
      coverage?: string[];
      gaps?: WikiDelegateGap[];
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WikiTaskExecutionError";
  }
}

/** Internal control signal: provider pauses never become model-visible tool results. */
export class WikiTaskPauseError extends Error {
  constructor(
    readonly reason: "quota" | "usage_limit",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "WikiTaskPauseError";
  }
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("UTF-8 byte limit must be a non-negative safe integer");
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let result = "";
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}

export function boundedDelegateSummary(value: string): string {
  const text = value.trim();
  if (Buffer.byteLength(text, "utf8") <= 1024) return text;
  return `${truncateUtf8(text, 1021)}...`;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FAILURE_CODES = new Set<WikiTaskFailureCode>([
  "rate_limit", "quota", "usage_limit", "server_error", "network_reset", "timeout", "context_exhausted",
  "unauthorized", "forbidden", "billing", "invalid_request", "schema", "artifact_io", "cancelled", "unknown",
  "delegated_tasks_exhausted", "delegate_batches_exhausted", "session_turns_exhausted",
  "session_tool_calls_exhausted",
]);

export function parseWikiDelegateTask(value: unknown): WikiDelegateTask {
  const raw = record(value, "Wiki delegate task");
  exactKeys(raw, ["id", "role", "instruction", "sourceScopeIds", "contextRefs", "writePaths", "reviewPaths", "mode", "assignmentIds", "domainScopeIds", "lensScopeIds", "resolvesIds"], "Wiki delegate task");
  const id = safeId(raw.id, "Wiki delegate task id");
  const instruction = nonEmpty(raw.instruction, "Wiki delegate instruction");
  const sourceScopeIds = strings(raw.sourceScopeIds, "Wiki delegate sourceScopeIds");
  const contextRefs = strings(raw.contextRefs, "Wiki delegate contextRefs");
  if (new Set(sourceScopeIds).size !== sourceScopeIds.length || new Set(contextRefs).size !== contextRefs.length) throw new Error("Wiki delegate scopes and context refs must be unique");
  if (raw.role === "research") {
    if (raw.writePaths !== undefined || raw.reviewPaths !== undefined) throw new Error("Research delegate cannot declare writePaths or reviewPaths");
    if (raw.mode !== "discovery" && raw.mode !== "supplement") throw new Error("Research delegate requires mode discovery or supplement");
    const assignmentIds = nonEmptyStrings(raw.assignmentIds, "Wiki research assignmentIds");
    const domainScopeIds = strings(raw.domainScopeIds, "Wiki research domainScopeIds");
    const lensScopeIds = strings(raw.lensScopeIds, "Wiki research lensScopeIds");
    const resolvesIds = strings(raw.resolvesIds, "Wiki research resolvesIds");
    if ([assignmentIds, domainScopeIds, lensScopeIds, resolvesIds].some((items) => new Set(items).size !== items.length)) throw new Error("Wiki research scope IDs must be unique");
    return { id, role: "research", instruction, sourceScopeIds, contextRefs, mode: raw.mode, assignmentIds, domainScopeIds, lensScopeIds, resolvesIds };
  }
  if (raw.role === "write") {
    if (raw.reviewPaths !== undefined) throw new Error("Write delegate cannot declare reviewPaths");
    const writePaths = nonEmptyStrings(raw.writePaths, "Wiki writePaths");
    assertAssignedWikiPaths(writePaths, "writePaths");
    return { id, role: "write", instruction, sourceScopeIds, contextRefs, writePaths };
  }
  if (raw.role === "review") {
    if (raw.writePaths !== undefined) throw new Error("Review delegate cannot declare writePaths");
    const reviewPaths = nonEmptyStrings(raw.reviewPaths, "Wiki reviewPaths");
    assertAssignedWikiPaths(reviewPaths, "reviewPaths");
    return { id, role: "review", instruction, sourceScopeIds, contextRefs, reviewPaths };
  }
  throw new Error("Invalid Wiki delegate role");
}

export function parseWikiReviewBasis(value: unknown): WikiReviewBasis {
  const raw = record(value, "Wiki review basis");
  exactKeys(raw, ["version", "candidateRevision", "treeDigest", "policyDigest", "paths"], "Wiki review basis");
  if (raw.version !== 1 || !Number.isSafeInteger(raw.candidateRevision) || (raw.candidateRevision as number) < 0) throw new Error("Invalid Wiki review basis revision");
  const paths = nonEmptyStrings(raw.paths, "Wiki review paths");
  assertAssignedWikiPaths(paths, "review paths");
  return {
    version: 1,
    candidateRevision: raw.candidateRevision as number,
    treeDigest: digest(raw.treeDigest, "Wiki review tree digest"),
    policyDigest: digest(raw.policyDigest, "Wiki review policy digest"),
    paths,
  };
}

export function parseWikiDelegateContract(value: unknown): WikiDelegateContract {
  const raw = record(value, "Wiki delegate contract");
  exactKeys(raw, ["id", "role", "instruction", "sourceScopeIds", "contextRefs", "writePaths", "reviewPaths", "mode", "assignmentIds", "domainScopeIds", "lensScopeIds", "resolvesIds", "contractVersion", "contractId", "contractDigest", "batchId", "reviewBasis"], "Wiki delegate contract");
  const task = parseWikiDelegateTask(Object.fromEntries(Object.entries(raw).filter(([key]) => !["contractVersion", "contractId", "contractDigest", "batchId", "reviewBasis"].includes(key))));
  if (raw.contractVersion !== 2 || !Number.isSafeInteger(raw.batchId) || (raw.batchId as number) < 1) throw new Error("Invalid Wiki delegate contract version or batch");
  const basis = raw.reviewBasis === undefined ? undefined : parseWikiReviewBasis(raw.reviewBasis);
  if ((task.role === "review") !== Boolean(basis)) throw new Error("Only review delegate contracts require a review basis");
  if (basis && !sameStringSet(basis.paths, task.reviewPaths ?? [])) throw new Error("Wiki review basis paths must exactly match the assigned review paths");
  const contract: WikiDelegateContract = {
    ...task,
    contractVersion: 2,
    contractId: safeId(raw.contractId, "Wiki delegate contract id"),
    contractDigest: digest(raw.contractDigest, "Wiki delegate contract digest"),
    batchId: raw.batchId as number,
    ...(basis ? { reviewBasis: basis } : {}),
  };
  if (contract.contractId !== `b${contract.batchId}-${contract.id}`) throw new Error("Wiki delegate contract identity does not match batch/task");
  const { contractDigest, ...body } = contract;
  if (hashContract(body) !== contractDigest) throw new Error("Wiki delegate contract digest mismatch");
  return contract;
}

export function parseWikiDelegateError(value: unknown): WikiDelegateError {
  const raw = record(value, "Wiki delegate error");
  exactKeys(raw, ["code", "message", "retryable", "retryAfterMs"], "Wiki delegate error");
  if (!FAILURE_CODES.has(raw.code as WikiTaskFailureCode) || typeof raw.retryable !== "boolean") throw new Error("Invalid Wiki delegate error");
  const retryAfterMs = raw.retryAfterMs;
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || (retryAfterMs as number) < 0)) throw new Error("Invalid Wiki delegate retryAfterMs");
  return { code: raw.code as WikiTaskFailureCode, message: nonEmpty(raw.message, "Wiki delegate error message"), retryable: raw.retryable, ...(retryAfterMs !== undefined ? { retryAfterMs: retryAfterMs as number } : {}) };
}

export function parseWikiDelegateReceipt(value: unknown): WikiDelegateReceipt {
  const raw = record(value, "Wiki delegate receipt");
  exactKeys(raw, ["id", "role", "status", "summary", "outputs", "completedAssignmentIds", "needsFollowup", "followups", "domains", "coverage", "gaps", "error", "attempts", "review", "contractId", "contractDigest"], "Wiki delegate receipt");
  const id = safeId(raw.id, "Wiki delegate receipt id");
  if (!["research", "write", "review"].includes(String(raw.role)) || !["complete", "incomplete", "failed"].includes(String(raw.status))
    || !Number.isSafeInteger(raw.attempts) || (raw.attempts as number) < 1 || !Array.isArray(raw.outputs)) {
    throw new Error("Invalid Wiki delegate receipt");
  }
  const role = raw.role as WikiDelegateRole;
  const expectedKind: WikiArtifactKind = role === "research" ? "research-handoff" : role === "write" ? "write-handoff" : "review-handoff";
  const outputs = raw.outputs.map(parseWikiArtifactRef);
  if (outputs.some((output) => output.kind !== expectedKind)) throw new Error("Wiki delegate output kind does not match role");
  const review = raw.review === undefined ? undefined : parseWikiReviewResult(raw.review);
  if ((review !== undefined) !== (role === "review" && raw.status === "complete")) throw new Error("Only complete review receipts may contain a review result");
  const error = raw.error === undefined ? undefined : parseWikiDelegateError(raw.error);
  if (raw.status === "complete" && error || raw.status === "failed" && !error) throw new Error("Invalid Wiki delegate receipt error/status combination");
  const contractId = safeId(raw.contractId, "Wiki delegate receipt contract id");
  const contractDigest = digest(raw.contractDigest, "Wiki delegate receipt contract digest");
  const completedAssignmentIds = raw.completedAssignmentIds === undefined ? undefined : strings(raw.completedAssignmentIds, "Wiki delegate completedAssignmentIds");
  if (completedAssignmentIds && new Set(completedAssignmentIds).size !== completedAssignmentIds.length) throw new Error("Wiki delegate completedAssignmentIds must be unique");
  const needsFollowup = raw.needsFollowup;
  if (needsFollowup !== undefined && typeof needsFollowup !== "boolean") throw new Error("Invalid Wiki delegate needsFollowup");
  const followups = raw.followups === undefined ? undefined : parseDelegateFollowups(raw.followups);
  const domains = raw.domains === undefined ? undefined : parseResearchDomains(raw.domains);
  if (role === "research" && raw.status !== "failed" && (completedAssignmentIds === undefined || needsFollowup === undefined || followups === undefined || domains === undefined)) {
    throw new Error("Research receipts require completion controls");
  }
  if (role === "research" && followups && needsFollowup !== (followups.length > 0)) throw new Error("Research receipt needsFollowup must match followups");
  if (role === "research" && raw.status === "incomplete" && needsFollowup === false) throw new Error("Incomplete research receipt requires followups");
  if (role === "research" && raw.status === "complete" && followups && followups.length > 0) throw new Error("Complete Wiki research requires empty followups");
  if (role === "research" && raw.status === "complete" && domains && domains.length === 0) throw new Error("Complete Wiki research requires domains");
  if (role !== "research" && (completedAssignmentIds !== undefined || needsFollowup !== undefined || followups !== undefined || domains !== undefined)) {
    throw new Error("Only research receipts may contain completion controls");
  }
  return {
    id,
    role,
    status: raw.status as WikiDelegateStatus,
    summary: nonEmpty(raw.summary, "Wiki delegate receipt summary"),
    outputs,
    ...(raw.coverage === undefined ? {} : { coverage: strings(raw.coverage, "Wiki delegate receipt coverage") }),
    ...(raw.gaps === undefined ? {} : { gaps: parseReceiptGaps(raw.gaps) }),
    ...(error ? { error } : {}),
    attempts: raw.attempts as number,
    ...(completedAssignmentIds ? { completedAssignmentIds } : {}),
    ...(needsFollowup !== undefined ? { needsFollowup } : {}),
    ...(followups ? { followups } : {}),
    ...(domains ? { domains } : {}),
    ...(review ? { review } : {}),
    contractId,
    contractDigest,
  };
}

/** Remove durable contract and artifact identities before crossing the public API boundary. */
export function projectWikiAgentOutcome(value: unknown): WikiAgentOutcome {
  const receipt = parseWikiDelegateReceipt(value);
  return {
    id: receipt.id,
    role: receipt.role,
    status: receipt.status,
    summary: receipt.summary,
    coverage: [...(receipt.coverage ?? receipt.completedAssignmentIds ?? [])],
    gaps: structuredClone(receipt.gaps ?? []),
    ...(receipt.completedAssignmentIds ? { completedAssignmentIds: [...receipt.completedAssignmentIds] } : {}),
    ...(receipt.followups?.length ? { followups: structuredClone(receipt.followups) } : {}),
    ...(receipt.domains?.length ? { domains: structuredClone(receipt.domains) } : {}),
    ...(receipt.error ? { error: { ...receipt.error } } : {}),
    attempts: receipt.attempts,
    ...(receipt.review ? { review: structuredClone(receipt.review) } : {}),
  };
}

/** Lead-visible batch snapshot: inventory, not artifact identity. */
export function projectWikiLeadSnapshot(snapshot: WikiDelegateBatchSnapshot): {
  batchId: number;
  status: WikiDelegateBatchSnapshot["status"];
  pendingTaskIds: string[];
  receipts: WikiAgentOutcome[];
} {
  return {
    batchId: snapshot.batchId,
    status: snapshot.status,
    pendingTaskIds: [...snapshot.pendingTaskIds],
    receipts: snapshot.receipts.map((receipt) => projectWikiAgentOutcome(receipt)),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unknown fields`);
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`Invalid ${label}`);
  return [...value];
}

function nonEmptyStrings(value: unknown, label: string): string[] {
  const result = strings(value, label);
  if (!result.length) throw new Error(`${label} must not be empty`);
  return result;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseWikiArtifactRef(value: unknown): WikiArtifactRef {
  const raw = record(value, "Wiki artifact reference");
  exactKeys(raw, ["version", "runId", "contractId", "attempt", "scope", "kind", "relativePath", "sha256", "sizeBytes", "mediaType"], "Wiki artifact reference");
  if (raw.version !== 1 || !["research-handoff", "write-handoff", "review-handoff"].includes(String(raw.kind)) || raw.mediaType !== "text/markdown"
    || !Number.isSafeInteger(raw.attempt) || (raw.attempt as number) < 1 || !Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0 || (raw.sizeBytes as number) > MAX_WIKI_RESEARCH_ARTIFACT_BYTES) throw new Error("Invalid Wiki artifact reference");
  const sha256 = digest(raw.sha256, "Wiki artifact digest");
  if (raw.relativePath !== `.okf-wiki/blobs/${sha256}.md`) throw new Error("Invalid Wiki artifact path");
  const scope = strings(raw.scope, "Wiki artifact scope");
  return { version: 1, runId: safeId(raw.runId, "Wiki artifact run id"), contractId: safeId(raw.contractId, "Wiki artifact contract id"), attempt: raw.attempt as number, scope, kind: raw.kind as WikiArtifactKind, relativePath: raw.relativePath, sha256, sizeBytes: raw.sizeBytes as number, mediaType: "text/markdown" };
}

export function parseWikiDelegateGap(value: unknown): WikiDelegateGap {
  const raw = record(value, "Wiki delegate gap");
  exactKeys(raw, ["question", "sourceScopeIds"], "Wiki delegate gap");
  return { question: nonEmpty(raw.question, "Wiki delegate gap question"), ...(raw.sourceScopeIds === undefined ? {} : { sourceScopeIds: strings(raw.sourceScopeIds, "Wiki delegate gap sourceScopeIds") }) };
}

function assertAssignedWikiPaths(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value) => !safeAssignedWikiPath(value))) throw new Error(`Invalid Wiki ${label}`);
}
function safeAssignedWikiPath(value: string): boolean {
  return value.startsWith("wiki/") && isSafeWikiPagePath(value.slice("wiki/".length));
}

function hashContract(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }

function parseResearchFollowups(value: unknown): WikiResearchFollowupDraft[] {
  if (!Array.isArray(value)) throw new Error("Invalid Wiki research followups");
  return value.map((item) => {
    const raw = record(item, "Wiki research followup");
    exactKeys(raw, ["kind", "question", "sourceScopeIds"], "Wiki research followup");
    const kind = parseFollowupKind(raw.kind);
    const question = nonEmpty(raw.question, "Wiki research followup question");
    if (Buffer.byteLength(question, "utf8") > 512) throw new Error("Wiki research followup question exceeds 512 bytes");
    const sourceScopeIds = strings(raw.sourceScopeIds, "Wiki research followup sourceScopeIds");
    if (new Set(sourceScopeIds).size !== sourceScopeIds.length) throw new Error("Wiki research followup sourceScopeIds must be unique");
    return { kind, question, sourceScopeIds };
  });
}

function parseFollowupKind(value: unknown): WikiFollowupKind {
  if (!(WIKI_FOLLOWUP_KINDS as readonly string[]).includes(String(value))) throw new Error("Invalid Wiki delegate followup kind");
  return value as WikiFollowupKind;
}

function parseDelegateFollowups(value: unknown): WikiDelegateFollowup[] {
  if (!Array.isArray(value)) throw new Error("Invalid Wiki delegate followups");
  const result = value.map((item) => {
    const raw = record(item, "Wiki delegate followup");
    exactKeys(raw, ["id", "kind", "question", "sourceScopeIds"], "Wiki delegate followup");
    const draft = parseResearchFollowups([{ kind: raw.kind, question: raw.question, sourceScopeIds: raw.sourceScopeIds }])[0];
    return { id: safeId(raw.id, "Wiki delegate followup id"), ...draft };
  });
  if (new Set(result.map((followup) => followup.id)).size !== result.length) throw new Error("Wiki delegate followup IDs must be unique");
  return result;
}

function parseReceiptGaps(value: unknown): WikiDelegateGap[] {
  if (!Array.isArray(value)) throw new Error("Invalid Wiki delegate receipt gaps");
  return value.map(parseWikiDelegateGap);
}

export function canonicalWikiFollowupId(contractId: string, followup: WikiResearchFollowupDraft): string {
  const digest = createHash("sha256").update(stableStringify({ contractId, ...followup })).digest("hex").slice(0, 24);
  return `f-${digest}`;
}
