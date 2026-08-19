import YAML from "yaml";
import type { WikiArtifactKind, WikiArtifactRef } from "./artifact-store.js";
import { extractSourceCitations, type SourceCitation } from "./citations.js";
import {
  parseWikiResearchSignal,
  parseWikiReviewResult,
  truncateUtf8,
  WIKI_FOLLOWUP_KINDS,
  type WikiDelegateContract,
  type WikiDelegateRole,
  type WikiFollowupKind,
  type WikiResearchDomainDraft,
  type WikiResearchFollowupDraft,
  type WikiResearchSignal,
  type WikiReviewResult,
} from "./delegate-contracts.js";
import { isRecord, splitYamlFence } from "./util.js";
import { decodeUtf8Fatal, MAX_WIKI_WORK_FILE_BYTES, summarizeWikiMarkdown } from "./wiki-work-files.js";
import { errorMessage } from "./failures.js";
import { WikiRejectedError, allowedList, listed } from "./wiki-reject.js";

const TAXONOMY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface EvidenceLedgerFinding {
  id: string;
  path?: string;
}

export interface EvidenceLedgerIndexes {
  assignmentIds: string[];
  pageIds: string[];
  findings: EvidenceLedgerFinding[];
  citations: SourceCitation[];
}

export interface EvidenceLedgerEntry {
  artifact: WikiArtifactRef;
  role: WikiDelegateRole;
  indexes: EvidenceLedgerIndexes;
  completedAssignmentIds: string[];
  followups: WikiResearchFollowupDraft[];
}

export interface EvidenceLedgerInput {
  artifact: WikiArtifactRef;
  markdown: string;
  contract: WikiDelegateContract;
  completedAssignmentIds?: readonly string[];
  followups?: readonly WikiResearchFollowupDraft[];
}

export interface InspectHandoffInput {
  bytes: Uint8Array | string;
  contract: WikiDelegateContract;
  finish?: { field: "status" | "verdict"; value: string };
  fileLines?: (citation: SourceCitation) => number | "missing" | undefined;
}

export type InspectHandoffResult =
  | { defects: string[] }
  | { ok: true; markdown: string; indexes: EvidenceLedgerIndexes; research?: WikiResearchSignal; review?: WikiReviewResult };

/** One accept/reject decision for a research, write, or review work file. */
export function inspectHandoff(input: InspectHandoffInput): InspectHandoffResult {
  const role = input.contract.role;
  const file = workFile(role);
  const opened = openHandoff(input.bytes, file);
  if ("defects" in opened) return opened;
  const yamlRequired = yamlRequiredFor(role, input.finish);
  const split = splitYamlFence(opened.text);
  const defects: string[] = [];
  let research: { status: "complete" | "incomplete"; followups: WikiResearchFollowupDraft[]; domains: WikiResearchDomainDraft[] } | undefined;
  let review: { verdict: "pass" | "changes_requested"; reviewedPaths: string[]; findings: WikiReviewResult["findings"]; profileCoverage: string[] } | undefined;

  if (yamlRequired) {
    const mapping = readYamlMapping(split, file);
    if ("defects" in mapping) return mapping;
    if (role === "research" && input.finish?.field === "status") {
      const status = researchStatus(input.finish.value);
      research = collectResearchYaml(mapping.frontmatter, status, input.contract.sourceScopeIds, defects);
    } else if (role === "review" && input.finish?.field === "verdict") {
      const verdict = reviewVerdict(input.finish.value);
      review = collectReviewYaml(mapping.frontmatter, verdict, input.contract.reviewPaths ?? [], defects);
    }
  } else {
    if (!opened.text.trim()) return { defects: ["Evidence handoff Markdown must not be empty"] };
    if (split.hasFence && !split.terminated) return { defects: ["handoff must contain terminated YAML frontmatter"] };
  }

  const lines = split.body.split(/\r?\n/);
  const { sections, hasLevelOne } = collectSections(lines);
  if (!hasLevelOne) defects.push("missing level-one role heading");
  const missing = requiredHeadings(role).filter((heading) => !sections.includes(heading.slug));
  if (missing.length) defects.push(`missing headings: ${listed(missing.map((heading) => heading.display))}`);
  const parsed = collectIndexes(lines, input.fileLines);
  defects.push(...parsed.defects);
  defects.push(...collectRoleIndexDefects(role, input.contract, parsed.indexes));
  if (defects.length) return { defects };

  return {
    ok: true,
    markdown: opened.text,
    indexes: parsed.indexes,
    ...(research
      ? {
          research: parseWikiResearchSignal({
            status: research.status,
            summary: summarizeWikiMarkdown(split.body),
            needsFollowup: research.followups.length > 0,
            followups: research.followups,
            domains: research.domains,
          }),
        }
      : {}),
    ...(review
      ? {
          review: parseWikiReviewResult({
            verdict: review.verdict,
            reviewedPaths: review.reviewedPaths,
            findings: review.findings,
            profileCoverage: review.profileCoverage,
          }),
        }
      : {}),
  };
}

/** Validate and index one immutable handoff. Prose never crosses this seam. */
export function ingestEvidenceHandoff(input: EvidenceLedgerInput): EvidenceLedgerEntry {
  const role = input.contract.role;
  const expectedKind = artifactKind(role);
  if (input.artifact.kind !== expectedKind) throw new Error(`Evidence handoff kind ${input.artifact.kind} does not match ${role}`);
  if (!input.artifact.runId || !input.artifact.contractId || input.artifact.attempt < 1) {
    throw new Error("Evidence handoff requires host-owned identity metadata");
  }
  const inspected = inspectHandoff({ bytes: input.markdown, contract: input.contract });
  if (!("ok" in inspected)) throw new WikiRejectedError(inspected.defects);
  const hostDefects = collectHostOwnedIndexDefects(role, input.contract, input.completedAssignmentIds, input.followups);
  if (hostDefects.length) throw new WikiRejectedError(hostDefects);
  return {
    artifact: structuredClone(input.artifact),
    role,
    indexes: inspected.indexes,
    completedAssignmentIds: [...(input.completedAssignmentIds ?? [])],
    followups: structuredClone([...(input.followups ?? [])]),
  };
}

function workFile(role: WikiDelegateRole): "handoff.md" | "review.md" {
  return role === "review" ? "review.md" : "handoff.md";
}

function yamlRequiredFor(role: WikiDelegateRole, finish: InspectHandoffInput["finish"]): boolean {
  return (role === "research" && finish?.field === "status") || (role === "review" && finish?.field === "verdict");
}

function openHandoff(bytes: Uint8Array | string, file: "handoff.md" | "review.md"): { defects: string[] } | { text: string } {
  const size = typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.byteLength;
  if (size > MAX_WIKI_WORK_FILE_BYTES) return { defects: [`${file} exceeds 256 KiB`] };
  try {
    return { text: typeof bytes === "string" ? bytes : decodeUtf8Fatal(bytes) };
  } catch {
    return { defects: ["Malformed UTF-8 input"] };
  }
}

function readYamlMapping(
  split: ReturnType<typeof splitYamlFence>,
  file: "handoff.md" | "review.md",
): { defects: string[] } | { frontmatter: Record<string, unknown> } {
  if (!split.hasFence || !split.terminated || split.yaml === undefined) {
    return { defects: [`${file} must contain terminated YAML frontmatter`] };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(split.yaml);
  } catch (error) {
    return { defects: [`Invalid ${file} YAML frontmatter: ${errorMessage(error)}`] };
  }
  if (!isRecord(parsed)) return { defects: [`${file} frontmatter must be a mapping`] };
  if (!split.body.trim()) return { defects: [`${file} body must be nonempty`] };
  return { frontmatter: parsed };
}

function researchStatus(value: string): "complete" | "incomplete" {
  if (value !== "complete" && value !== "incomplete") throw new Error("Invalid Wiki research completion status");
  return value;
}

function reviewVerdict(value: string): "pass" | "changes_requested" {
  if (value !== "pass" && value !== "changes_requested") throw new Error("Invalid Wiki review verdict");
  return value;
}

function collectResearchYaml(
  frontmatter: Record<string, unknown>,
  status: "complete" | "incomplete",
  sourceScopeIds: readonly string[],
  defects: string[],
): { status: "complete" | "incomplete"; followups: WikiResearchFollowupDraft[]; domains: WikiResearchDomainDraft[] } {
  defects.push(...collectExactKeys(frontmatter, ["followups", "domains"], "handoff.md frontmatter"));
  const followups = collectResearchFollowups(frontmatter.followups, sourceScopeIds, defects);
  const domains = collectResearchDomains(frontmatter.domains, defects);
  if (status === "incomplete" && Array.isArray(frontmatter.followups) && frontmatter.followups.length === 0) {
    defects.push("incomplete research requires followups");
  }
  if (status === "complete" && Array.isArray(frontmatter.followups) && frontmatter.followups.length > 0) {
    defects.push("complete research requires empty followups");
  }
  if (status === "complete" && Array.isArray(frontmatter.domains) && frontmatter.domains.length === 0) {
    defects.push("complete research requires domains");
  }
  return { status, followups, domains };
}

function collectReviewYaml(
  frontmatter: Record<string, unknown>,
  verdict: "pass" | "changes_requested",
  assignedPaths: readonly string[],
  defects: string[],
): { verdict: "pass" | "changes_requested"; reviewedPaths: string[]; findings: WikiReviewResult["findings"]; profileCoverage: string[] } {
  if (!assignedPaths.length) throw new Error("review.md assignedPaths must not be empty");
  const reviewedPaths = [...assignedPaths];
  defects.push(...collectExactKeys(frontmatter, ["findings", "profileCoverage"], "review.md frontmatter"));
  const findings = collectReviewFindings(frontmatter.findings, new Set(reviewedPaths), reviewedPaths, defects);
  const profileCoverage = collectStringArray(frontmatter.profileCoverage, "review.md frontmatter.profileCoverage", defects);
  return { verdict, reviewedPaths, findings, profileCoverage };
}

function collectResearchFollowups(
  raw: unknown,
  scopes: readonly string[],
  defects: string[],
): WikiResearchFollowupDraft[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    defects.push("handoff.md frontmatter.followups must be an array");
    return [];
  }
  const followups: WikiResearchFollowupDraft[] = [];
  for (const [index, value] of raw.entries()) {
    const field = `handoff.md frontmatter.followups[${index}]`;
    if (!isRecord(value)) {
      defects.push(`${field} must be a mapping`);
      continue;
    }
    const before = defects.length;
    defects.push(...collectExactKeys(value, ["kind", "question"], field));
    let kind: WikiFollowupKind | undefined;
    if (Object.hasOwn(value, "kind")) {
      if ((WIKI_FOLLOWUP_KINDS as readonly unknown[]).includes(value.kind)) kind = value.kind as WikiFollowupKind;
      else defects.push(`${field}.kind ${JSON.stringify(value.kind)} is not supported (allowed: ${listed(WIKI_FOLLOWUP_KINDS)})`);
    }
    let question: string | undefined;
    if (Object.hasOwn(value, "question")) {
      if (typeof value.question === "string" && value.question.trim()) question = truncateUtf8(value.question.trim(), 512);
      else defects.push(`${field}.question must be a nonempty string`);
    }
    if (defects.length === before && kind && question) {
      followups.push({ kind, question, sourceScopeIds: [...scopes] });
    }
  }
  return followups;
}

function collectResearchDomains(raw: unknown, defects: string[]): WikiResearchDomainDraft[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    defects.push("handoff.md frontmatter.domains must be an array");
    return [];
  }
  const domains: WikiResearchDomainDraft[] = [];
  for (const [index, value] of raw.entries()) {
    const field = `handoff.md frontmatter.domains[${index}]`;
    if (!isRecord(value)) {
      defects.push(`${field} must be a mapping`);
      continue;
    }
    const before = defects.length;
    defects.push(...collectExactKeys(value, ["id", "conceptIds"], field));
    let id: string | undefined;
    if (Object.hasOwn(value, "id")) {
      if (typeof value.id === "string" && value.id.trim()) {
        id = value.id.trim();
        if (!TAXONOMY_SLUG.test(id)) defects.push(`${field}.id must be a lowercase ASCII slug`);
      } else defects.push(`${field}.id must be a nonempty string`);
    }
    let conceptIds: string[] | undefined;
    if (Object.hasOwn(value, "conceptIds")) {
      if (!Array.isArray(value.conceptIds) || value.conceptIds.some((conceptId) => typeof conceptId !== "string" || !conceptId.trim())) {
        defects.push(`${field}.conceptIds must be an array of nonempty strings`);
      } else {
        conceptIds = value.conceptIds.map((conceptId) => String(conceptId).trim());
        if (conceptIds.some((conceptId) => !TAXONOMY_SLUG.test(conceptId))) {
          defects.push(`${field}.conceptIds must be lowercase ASCII slugs`);
        }
        if (new Set(conceptIds).size !== conceptIds.length) defects.push(`${field}.conceptIds must be unique`);
      }
    }
    if (defects.length === before && id && conceptIds) domains.push({ id, conceptIds });
  }
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length) {
    defects.push("handoff.md frontmatter.domains ids must be unique");
  }
  return domains;
}

function collectReviewFindings(
  raw: unknown,
  assigned: Set<string>,
  reviewedPaths: readonly string[],
  defects: string[],
): WikiReviewResult["findings"] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    defects.push("review.md frontmatter.findings must be an array");
    return [];
  }
  const findings: WikiReviewResult["findings"] = [];
  for (const [index, value] of raw.entries()) {
    const field = `review.md frontmatter.findings[${index}]`;
    if (!isRecord(value)) {
      defects.push(`${field} must be a mapping`);
      continue;
    }
    const before = defects.length;
    defects.push(...collectExactKeys(value, ["path", "severity"], field));
    let path: string | undefined;
    if (Object.hasOwn(value, "path")) {
      if (typeof value.path === "string" && value.path.trim()) {
        path = value.path.trim();
        if (!assigned.has(path)) {
          defects.push(`${field}.path "${path}" is outside assigned paths (assigned: ${allowedList(reviewedPaths)})`);
        }
      } else defects.push(`${field}.path must be a nonempty string`);
    }
    let severity: "critical" | "major" | "minor" | undefined;
    if (Object.hasOwn(value, "severity")) {
      if (value.severity === "critical" || value.severity === "major" || value.severity === "minor") severity = value.severity;
      else defects.push(`${field}.severity must be critical, major, or minor`);
    }
    if (defects.length === before && path && severity) {
      findings.push({ id: `finding-${index + 1}`, path, severity });
    }
  }
  return findings;
}

function collectStringArray(value: unknown, field: string, defects: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    defects.push(`${field} must be an array of nonempty strings`);
    return [];
  }
  return value.map((item) => String(item).trim());
}

function collectExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): string[] {
  const defects: string[] = [];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) defects.push(`${field} has unknown fields: ${listed(unknown)}`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) defects.push(`${field} missing fields: ${listed(missing)}`);
  return defects;
}

function artifactKind(role: WikiDelegateRole): WikiArtifactKind {
  return role === "research" ? "research-handoff" : role === "write" ? "write-handoff" : "review-handoff";
}

function requiredHeadings(role: WikiDelegateRole): Array<{ slug: string; display: string }> {
  if (role === "research") {
    return [
      { slug: "research handoff", display: "Research Handoff" },
      { slug: "scope", display: "Scope" },
      { slug: "coverage", display: "Coverage" },
      { slug: "evidence", display: "Evidence" },
      { slug: "conflicts and alternatives", display: "Conflicts and alternatives" },
      { slug: "gaps and failed reads", display: "Gaps and failed reads" },
    ];
  }
  if (role === "write") return [{ slug: "write handoff", display: "Write Handoff" }];
  return [
    { slug: "review handoff", display: "Review Handoff" },
    { slug: "findings", display: "Findings" },
    { slug: "evidence", display: "Evidence" },
  ];
}

function collectSections(lines: string[]): { sections: string[]; hasLevelOne: boolean } {
  const sections: string[] = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) sections.push(match[2].trim().toLowerCase());
  }
  const first = lines.find((line) => line.trim()) ?? "";
  return { sections, hasLevelOne: /^#\s+/.test(first) };
}

function collectIndexes(
  lines: string[],
  fileLines?: (citation: SourceCitation) => number | "missing" | undefined,
): { indexes: EvidenceLedgerIndexes; defects: string[] } {
  const assignments: string[] = [];
  const pages: string[] = [];
  const findings: EvidenceLedgerFinding[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/\bassignment:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/g)) assignments.push(match[1]);
    for (const match of line.matchAll(/\bpage:([^\s,;)]+)\b/g)) pages.push(match[1]);
    for (const match of line.matchAll(/\bfinding:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/g)) {
      const path = /\bpath:([^\s,;)]+)/.exec(line)?.[1];
      findings.push({ id: match[1], ...(path ? { path } : {}) });
    }
  }
  const extracted = extractSourceCitations(lines.join("\n"), fileLines);
  return {
    indexes: {
      assignmentIds: unique(assignments),
      pageIds: unique(pages),
      findings: uniqueFindings(findings),
      citations: extracted.citations,
    },
    defects: extracted.invalid.length ? [`invalid citations: ${listed(extracted.invalid)}`] : [],
  };
}

function collectRoleIndexDefects(
  role: WikiDelegateRole,
  contract: WikiDelegateContract,
  indexes: EvidenceLedgerIndexes,
): string[] {
  const defects: string[] = [];
  if (role !== "write" && indexes.citations.length === 0) {
    defects.push(`${role} handoff requires at least one source-qualified citation`);
  }
  const sourceScopes = contract.sourceScopeIds;
  const outside = unique(indexes.citations.map((citation) => citation.scope).filter((scope) => !sourceScopes.includes(scope)));
  if (outside.length) {
    defects.push(`citation scopes outside pinned scopes: ${listed(outside)} (allowed: ${allowedList(sourceScopes)})`);
  }
  if (role === "write") {
    const assigned = contract.writePaths ?? [];
    const assignedSet = new Set(assigned);
    const unassigned = indexes.pageIds.filter((page) => !assignedSet.has(page) && !assignedSet.has(`wiki/${page}`));
    if (unassigned.length) {
      defects.push(`unassigned page IDs: ${listed(unassigned)} (assigned: ${allowedList(assigned)})`);
    }
    return defects;
  }
  if (role === "review") {
    const assigned = contract.reviewPaths ?? [];
    const assignedSet = new Set(assigned);
    const outsidePaths = unique(
      indexes.findings.flatMap((finding) => finding.path !== undefined && !assignedSet.has(finding.path) ? [finding.path] : []),
    );
    if (outsidePaths.length) {
      defects.push(`review finding paths outside assigned paths: ${listed(outsidePaths)} (assigned: ${allowedList(assigned)})`);
    }
    return defects;
  }
  if (contract.role !== "research") throw new Error("Research handoff requires a research contract");
  const declared = contract.assignmentIds;
  const undeclared = indexes.assignmentIds.filter((id) => !declared.includes(id));
  if (undeclared.length) {
    defects.push(`undeclared assignment IDs: ${listed(undeclared)} (declared: ${allowedList(declared)})`);
  }
  return defects;
}

function collectHostOwnedIndexDefects(
  role: WikiDelegateRole,
  contract: WikiDelegateContract,
  completed?: readonly string[],
  followups?: readonly WikiResearchFollowupDraft[],
): string[] {
  if (role !== "research" || contract.role !== "research") return [];
  const defects: string[] = [];
  const declared = contract.assignmentIds;
  const undeclared = (completed ?? []).filter((id) => !declared.includes(id));
  if (undeclared.length) {
    defects.push(`undeclared assignment IDs: ${listed(undeclared)} (declared: ${allowedList(declared)})`);
  }
  const sourceScopes = contract.sourceScopeIds;
  const outside = unique((followups ?? []).flatMap((followup) => followup.sourceScopeIds.filter((scope) => !sourceScopes.includes(scope))));
  if (outside.length) {
    defects.push(`followup scopes outside pinned scopes: ${listed(outside)} (allowed: ${allowedList(sourceScopes)})`);
  }
  return defects;
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function uniqueFindings(values: readonly EvidenceLedgerFinding[]): EvidenceLedgerFinding[] {
  const seen = new Set<string>();
  return values.filter((finding) => !seen.has(finding.id) && seen.add(finding.id));
}
