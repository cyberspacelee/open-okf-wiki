import YAML from "yaml";
import {
  WIKI_FOLLOWUP_KINDS,
  parseWikiResearchSignal,
  parseWikiReviewResult,
  truncateUtf8,
  type WikiFollowupKind,
  type WikiResearchDomainDraft,
  type WikiResearchSignal,
  type WikiReviewResult,
} from "./delegate-contracts.js";
import { WikiRejectedError, allowedList, listed } from "./wiki-reject.js";

const TAXONOMY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_WIKI_WORK_FILE_BYTES = 256 * 1024;

type MarkdownInput = string | Uint8Array;

export interface WikiWorkFileSplit {
  yaml?: string;
  body: string;
  hasFence: boolean;
  terminated: boolean;
}

export interface ResearchHandoffInspection {
  defects: string[];
  structural: boolean;
  signal?: WikiResearchSignal;
}

export interface ReviewHandoffInspection {
  defects: string[];
  structural: boolean;
  result?: WikiReviewResult;
}

export function decodeUtf8Fatal(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Malformed UTF-8 input", { cause: error });
  }
}

/** Split optional terminated YAML from a Wiki work file. Accepts CRLF. */
export function splitWikiWorkFile(markdown: string): WikiWorkFileSplit {
  const hasFence = markdown.startsWith("---\n") || markdown.startsWith("---\r\n");
  if (!hasFence) return { body: markdown, hasFence: false, terminated: true };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return { body: markdown, hasFence: true, terminated: false };
  return { yaml: match[1], body: markdown.slice(match[0].length), hasFence: true, terminated: true };
}

export function inspectResearchHandoff(
  markdown: MarkdownInput,
  status: "complete" | "incomplete",
  allowedSourceScopes: readonly string[],
): ResearchHandoffInspection {
  const opened = openWorkFile(markdown, "handoff.md");
  if (opened.structural) return { defects: opened.defects, structural: true };
  const scopes = uniqueStrings(allowedSourceScopes, "handoff.md allowedSourceScopes");
  const defects: string[] = [];
  defects.push(...collectExactKeys(opened.frontmatter, ["followups", "domains"], "handoff.md frontmatter"));
  const followups = collectResearchFollowups(opened.frontmatter.followups, scopes, defects);
  const domains = collectResearchDomains(opened.frontmatter.domains, defects);
  if (status === "incomplete" && Array.isArray(opened.frontmatter.followups) && opened.frontmatter.followups.length === 0) {
    defects.push("incomplete research requires followups");
  }
  if (status === "complete" && Array.isArray(opened.frontmatter.followups) && opened.frontmatter.followups.length > 0) {
    defects.push("complete research requires empty followups");
  }
  if (status === "complete" && Array.isArray(opened.frontmatter.domains) && opened.frontmatter.domains.length === 0) {
    defects.push("complete research requires domains");
  }
  if (defects.length) return { defects, structural: false };
  return {
    defects: [],
    structural: false,
    signal: parseWikiResearchSignal({
      status,
      summary: summarizeWikiMarkdown(opened.body),
      needsFollowup: followups.length > 0,
      followups,
      domains,
    }),
  };
}

export function inspectReviewHandoff(
  markdown: MarkdownInput,
  verdict: "pass" | "changes_requested",
  assignedPaths: readonly string[],
): ReviewHandoffInspection {
  const opened = openWorkFile(markdown, "review.md");
  if (opened.structural) return { defects: opened.defects, structural: true };
  const reviewedPaths = nonEmptyUniqueStrings(assignedPaths, "review.md assignedPaths");
  const assigned = new Set(reviewedPaths);
  const defects: string[] = [];
  defects.push(...collectExactKeys(opened.frontmatter, ["findings", "profileCoverage"], "review.md frontmatter"));
  const findings = collectReviewFindings(opened.frontmatter.findings, assigned, reviewedPaths, defects);
  const profileCoverage = collectStringArray(opened.frontmatter.profileCoverage, "review.md frontmatter.profileCoverage", defects);
  if (defects.length) return { defects, structural: false };
  return {
    defects: [],
    structural: false,
    result: parseWikiReviewResult({ verdict, reviewedPaths, findings, profileCoverage }),
  };
}

export function parseResearchHandoff(
  markdown: MarkdownInput,
  status: "complete" | "incomplete",
  allowedSourceScopes: readonly string[],
): WikiResearchSignal {
  const inspected = inspectResearchHandoff(markdown, status, allowedSourceScopes);
  if (inspected.defects.length) throw new WikiRejectedError(inspected.defects);
  return inspected.signal!;
}

export function parseReviewHandoff(
  markdown: MarkdownInput,
  verdict: "pass" | "changes_requested",
  assignedPaths: readonly string[],
): WikiReviewResult {
  const inspected = inspectReviewHandoff(markdown, verdict, assignedPaths);
  if (inspected.defects.length) throw new WikiRejectedError(inspected.defects);
  return inspected.result!;
}

export function summarizeWikiMarkdown(markdown: string, _field?: string): string {
  return truncateUtf8(
    firstSubstantiveParagraph(markdown) ?? firstNonstructuralLine(markdown) ?? "Handoff accepted.",
    1024,
  );
}

function openWorkFile(markdown: MarkdownInput, file: "handoff.md" | "review.md"):
  | { structural: true; defects: string[] }
  | { structural: false; frontmatter: Record<string, unknown>; body: string } {
  const bytes = typeof markdown === "string" ? Buffer.byteLength(markdown, "utf8") : markdown.byteLength;
  if (bytes > MAX_WIKI_WORK_FILE_BYTES) return { structural: true, defects: [`${file} exceeds 256 KiB`] };
  let text: string;
  try {
    text = typeof markdown === "string" ? markdown : decodeUtf8Fatal(markdown);
  } catch {
    return { structural: true, defects: ["Malformed UTF-8 input"] };
  }
  const split = splitWikiWorkFile(text);
  if (!split.hasFence || !split.terminated || split.yaml === undefined) {
    return { structural: true, defects: [`${file} must contain terminated YAML frontmatter`] };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(split.yaml);
  } catch (error) {
    return { structural: true, defects: [`Invalid ${file} YAML frontmatter: ${errorMessage(error)}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { structural: true, defects: [`${file} frontmatter must be a mapping`] };
  }
  if (!split.body.trim()) return { structural: true, defects: [`${file} body must be nonempty`] };
  return { structural: false, frontmatter: parsed as Record<string, unknown>, body: split.body };
}

function collectResearchFollowups(
  raw: unknown,
  scopes: readonly string[],
  defects: string[],
): Array<{ kind: WikiFollowupKind; question: string; sourceScopeIds: string[] }> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    defects.push("handoff.md frontmatter.followups must be an array");
    return [];
  }
  const followups: Array<{ kind: WikiFollowupKind; question: string; sourceScopeIds: string[] }> = [];
  for (const [index, value] of raw.entries()) {
    const field = `handoff.md frontmatter.followups[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      defects.push(`${field} must be a mapping`);
      continue;
    }
    const item = value as Record<string, unknown>;
    const before = defects.length;
    defects.push(...collectExactKeys(item, ["kind", "question"], field));
    let kind: WikiFollowupKind | undefined;
    if (Object.hasOwn(item, "kind")) {
      if ((WIKI_FOLLOWUP_KINDS as readonly unknown[]).includes(item.kind)) kind = item.kind as WikiFollowupKind;
      else defects.push(`${field}.kind ${JSON.stringify(item.kind)} is not supported (allowed: ${listed(WIKI_FOLLOWUP_KINDS)})`);
    }
    let question: string | undefined;
    if (Object.hasOwn(item, "question")) {
      if (typeof item.question === "string" && item.question.trim()) question = truncateUtf8(item.question.trim(), 512);
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      defects.push(`${field} must be a mapping`);
      continue;
    }
    const item = value as Record<string, unknown>;
    const before = defects.length;
    defects.push(...collectExactKeys(item, ["id", "conceptIds"], field));
    let id: string | undefined;
    if (Object.hasOwn(item, "id")) {
      if (typeof item.id === "string" && item.id.trim()) {
        id = item.id.trim();
        if (!TAXONOMY_SLUG.test(id)) defects.push(`${field}.id must be a lowercase ASCII slug`);
      } else defects.push(`${field}.id must be a nonempty string`);
    }
    let conceptIds: string[] | undefined;
    if (Object.hasOwn(item, "conceptIds")) {
      if (!Array.isArray(item.conceptIds) || item.conceptIds.some((conceptId) => typeof conceptId !== "string" || !conceptId.trim())) {
        defects.push(`${field}.conceptIds must be an array of nonempty strings`);
      } else {
        conceptIds = item.conceptIds.map((conceptId) => String(conceptId).trim());
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
): Array<{ id: string; path: string; severity: "critical" | "major" | "minor" }> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    defects.push("review.md frontmatter.findings must be an array");
    return [];
  }
  const findings: Array<{ id: string; path: string; severity: "critical" | "major" | "minor" }> = [];
  for (const [index, value] of raw.entries()) {
    const field = `review.md frontmatter.findings[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      defects.push(`${field} must be a mapping`);
      continue;
    }
    const item = value as Record<string, unknown>;
    const before = defects.length;
    defects.push(...collectExactKeys(item, ["path", "severity"], field));
    let path: string | undefined;
    if (Object.hasOwn(item, "path")) {
      if (typeof item.path === "string" && item.path.trim()) {
        path = item.path.trim();
        if (!assigned.has(path)) {
          defects.push(`${field}.path "${path}" is outside assigned paths (assigned: ${allowedList(reviewedPaths)})`);
        }
      } else defects.push(`${field}.path must be a nonempty string`);
    }
    let severity: "critical" | "major" | "minor" | undefined;
    if (Object.hasOwn(item, "severity")) {
      if (item.severity === "critical" || item.severity === "major" || item.severity === "minor") severity = item.severity;
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

function firstSubstantiveParagraph(body: string): string | undefined {
  const paragraph: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    if (/^#{1,6}(?:\s|$)|^(?:```|~~~)|^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    const listItem = /^(?:[-+*]|\d+[.)])\s+/.test(line);
    const prose = line
      .replace(/^>\s*/, "")
      .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
      .trim();
    const structuralLabel = /^(?:\*\*[^*]+[:：]?\*\*|__[^_]+[:：]?__|[\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}[:：])(?:\s+.*)?$/u;
    if (!prose || structuralLabel.test(prose) && (listItem || /^\S[^.!?。！？]*[:：]$/.test(prose))) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    paragraph.push(prose);
  }
  if (paragraph.length) return paragraph.join(" ");
  return undefined;
}

function firstNonstructuralLine(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}(?:\s|$)|^(?:```|~~~)|^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    const prose = line.replace(/^>\s*/, "").replace(/^(?:[-+*]|\d+[.)])\s+/, "").trim();
    if (prose) return prose;
  }
  return undefined;
}

function nonEmptyUniqueStrings(value: readonly string[], field: string): string[] {
  const parsed = uniqueStrings(value, field);
  if (!parsed.length) throw new Error(`${field} must not be empty`);
  return parsed;
}

function uniqueStrings(value: readonly string[], field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of nonempty strings`);
  }
  const parsed = value.map((item) => item.trim());
  if (new Set(parsed).size !== parsed.length) throw new Error(`${field} must contain unique values`);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
