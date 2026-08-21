import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractOkfSources, resolveSourceCitation, type SourceCitation } from "./citations.js";
import { readText } from "./files.js";
import { parsePage } from "./frontmatter.js";
import { assertReadable, type WikiWriteGuard } from "./path-policy.js";

const MAX_STAGNANT_ROUNDS = 2;

interface EvidenceReceipt {
  file: string;
  startLine: number;
  endLine: number;
  fileDigest: string;
}

interface WriterEvidenceIssue {
  code: "citation-unread" | "catalog-undescribed";
  page: string;
  resource: string;
  message: string;
  suggestedAction: string;
}

export interface WriterEvidenceGate {
  observe(event: { tool: string; args: unknown; status: string; result?: unknown }): void;
  nextPrompt(): Promise<string | undefined>;
}

export function createWriterEvidenceGate(
  guard: WikiWriteGuard,
  options: { maxRepairRounds?: number; onTouched?: (location: string) => void } = {},
): WriterEvidenceGate {
  const maxRepairRounds = options.maxRepairRounds ?? 6;
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 1) {
    throw new Error("Writer evidence repair rounds must be a positive integer");
  }
  const touched = new Set<string>();
  const reads: Array<Promise<EvidenceReceipt | undefined>> = [];
  const describedTables = new Set<string>();
  let previousIssues: string | undefined;
  let stagnantRounds = 0;
  let repairRounds = 0;
  return {
    observe(event) {
      if (event.tool === "db_describe" && event.status === "complete") {
        for (const table of describedTableNames(event.result)) describedTables.add(table);
        return;
      }
      if (!isRecord(event.args) || typeof event.args.path !== "string") return;
      if (event.tool === "read" && event.status === "complete") {
        reads.push(captureEvidenceRead(guard, event.args, event.result));
      }
      if ((event.tool === "write" || event.tool === "edit") && event.status === "complete") {
        touched.add(event.args.path);
        options.onTouched?.(event.args.path);
      }
    },
    async nextPrompt() {
      const receipts = (await Promise.all(reads)).filter((entry): entry is EvidenceReceipt => entry !== undefined);
      const issues = await validateWriterEvidence(guard, touched, receipts, describedTables);
      if (!issues.length) return undefined;
      const issueDigest = writerEvidenceIssueDigest(issues);
      stagnantRounds = issueDigest === previousIssues ? stagnantRounds + 1 : 0;
      if (repairRounds >= maxRepairRounds || stagnantRounds >= MAX_STAGNANT_ROUNDS) {
        throw new Error([
          `Writer evidence repair did not converge after ${repairRounds} rounds.`,
          formatWriterEvidenceRepair(issues),
        ].join("\n"));
      }
      previousIssues = issueDigest;
      repairRounds += 1;
      return [
        formatWriterEvidenceRepair(issues),
        "Continue in this same session. Read every requested source span, then revise or remove any claim whose citation is not supported.",
        `Repair round ${repairRounds} of ${maxRepairRounds}. All listed issues are from one exhaustive check.`,
      ].join("\n\n");
    },
  };
}

async function captureEvidenceRead(
  guard: WikiWriteGuard,
  args: unknown,
  result: unknown,
): Promise<EvidenceReceipt | undefined> {
  if (!isRecord(args) || typeof args.path !== "string") return undefined;
  let file: string;
  try {
    file = path.resolve(assertReadable(guard, args.path));
  } catch {
    return undefined;
  }
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return undefined;
  }
  const totalLines = body.toString("utf8").split("\n").length;
  const startLine = positiveInteger(args.offset) ?? 1;
  const requested = positiveInteger(args.limit);
  const truncation = readTruncation(result);
  const truncatedLines = truncation?.truncated === true ? nonNegativeInteger(truncation.outputLines) : undefined;
  const available = Math.max(0, totalLines - startLine + 1);
  const lineCount = truncatedLines ?? Math.min(requested ?? available, available);
  if (lineCount < 1) return undefined;
  return {
    file,
    startLine,
    endLine: startLine + lineCount - 1,
    fileDigest: createHash("sha256").update(body).digest("hex"),
  };
}

async function validateWriterEvidence(
  guard: WikiWriteGuard,
  touched: ReadonlySet<string>,
  receipts: readonly EvidenceReceipt[],
  describedTables: ReadonlySet<string>,
): Promise<WriterEvidenceIssue[]> {
  const issues: WriterEvidenceIssue[] = [];
  const digests = new Map<string, string>();
  for (const location of [...touched].sort()) {
    const absolute = candidateFile(guard, location);
    if (!absolute) continue;
    let parsed;
    try {
      parsed = parsePage(await readText(absolute));
    } catch {
      continue;
    }
    const page = path.relative(guard.candidateRoot, absolute).replaceAll("\\", "/");
    for (const citation of extractOkfSources(parsed.frontmatter, parsed.body).citations) {
      if (citation.catalogTable) {
        if (describedTables.has(citation.catalogTable)) continue;
        issues.push({
          code: "catalog-undescribed",
          page,
          resource: citation.path,
          message: "The cited Catalog table was not successfully described in this writer session.",
          suggestedAction: `Call db_describe for ${citation.catalogTable}, then verify the claim or correct/remove the citation.`,
        });
        continue;
      }
      if (!resolveSourceCitation(citation, guard.sources)) continue;
      const file = path.resolve(guard.workspaceRoot, ...citation.path.split("/"));
      const currentDigest = await digest(file, digests);
      const reads = receipts.filter((receipt) => receipt.file === file && receipt.fileDigest === currentDigest);
      if (citationCovered(citation, reads)) continue;
      const resource = formatResource(citation);
      const startLine = citation.startLine;
      const endLine = citation.endLine;
      const hasRange = startLine !== undefined && endLine !== undefined;
      const range = hasRange ? `${startLine}-${endLine}` : undefined;
      issues.push({
        code: "citation-unread",
        page,
        resource,
        message: range
          ? `The successful read spans do not cover cited lines ${range}.`
          : "The cited pinned file was not successfully read in this writer session.",
        suggestedAction: hasRange
          ? `Read lines ${range} from ${citation.path} (offset=${startLine}, limit=${endLine - startLine + 1}), then verify the claim or correct/remove the citation.`
          : `Read ${citation.path}, then verify the claim or replace/remove the unsupported citation.`,
      });
    }
  }
  return uniqueIssues(issues);
}

function formatWriterEvidenceRepair(issues: readonly WriterEvidenceIssue[]): string {
  const lines = [
    `Writer evidence validation found ${issues.length} issue${issues.length === 1 ? "" : "s"}. Fix all issues in this batch before finishing:`,
  ];
  for (const issue of issues) {
    lines.push(
      `- [${issue.code}] ${issue.page}: ${issue.resource}`,
      `  ${issue.message}`,
      `  Suggested action: ${issue.suggestedAction}`,
    );
  }
  return lines.join("\n");
}

function writerEvidenceIssueDigest(issues: readonly WriterEvidenceIssue[]): string {
  return createHash("sha256")
    .update(issues.map((issue) => `${issue.code}\0${issue.page}\0${issue.resource}`).sort().join("\n"))
    .digest("hex");
}

function citationCovered(citation: SourceCitation, receipts: readonly EvidenceReceipt[]): boolean {
  if (!receipts.length) return false;
  if (citation.startLine === undefined || citation.endLine === undefined) return true;
  const spans = receipts
    .map(({ startLine, endLine }) => ({ startLine, endLine }))
    .sort((left, right) => left.startLine - right.startLine);
  let cursor = citation.startLine;
  for (const span of spans) {
    if (span.endLine < cursor) continue;
    if (span.startLine > cursor) return false;
    cursor = span.endLine + 1;
    if (cursor > citation.endLine) return true;
  }
  return false;
}

function candidateFile(guard: WikiWriteGuard, location: string): string | undefined {
  let absolute: string;
  try {
    absolute = assertReadable(guard, location);
  } catch {
    return undefined;
  }
  const relative = path.relative(guard.candidateRoot, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? absolute : undefined;
}

async function digest(file: string, cache: Map<string, string>): Promise<string> {
  const known = cache.get(file);
  if (known) return known;
  try {
    const value = createHash("sha256").update(await readFile(file)).digest("hex");
    cache.set(file, value);
    return value;
  } catch {
    return "missing";
  }
}

function formatResource(citation: SourceCitation): string {
  if (citation.startLine === undefined) return citation.path;
  return citation.startLine === citation.endLine
    ? `${citation.path}#L${citation.startLine}`
    : `${citation.path}#L${citation.startLine}-L${citation.endLine}`;
}

function uniqueIssues(issues: readonly WriterEvidenceIssue[]): WriterEvidenceIssue[] {
  const byKey = new Map<string, WriterEvidenceIssue>();
  for (const issue of issues) byKey.set(`${issue.page}\0${issue.resource}`, issue);
  return [...byKey.values()];
}

function describedTableNames(result: unknown): string[] {
  if (!isRecord(result) || !isRecord(result.details) || !Array.isArray(result.details.tables)) return [];
  return result.details.tables.filter((table): table is string => typeof table === "string");
}

function readTruncation(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.details) || !isRecord(value.details.truncation)) return undefined;
  return value.details.truncation;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
