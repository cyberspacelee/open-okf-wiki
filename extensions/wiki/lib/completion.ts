import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractOkfSources, resolveSourceCitation, type SourceCitation } from "./citations.js";
import { readText } from "./files.js";
import { parsePage } from "./frontmatter.js";
import { parseReviewVerdict } from "./handoff.js";
import { assertReadable, type WikiWriteGuard } from "./path-policy.js";
import { candidateTargetRevision } from "./revisions.js";
import type { WikiTemplatePack } from "./templates.js";
import type { createWriterTodoTracker } from "./writer-todo.js";
import { formatIssue, validateWikiTarget } from "./wiki-okf.js";

interface EvidenceReceipt {
  file: string;
  startLine: number;
  endLine: number;
  fileDigest: string;
}

interface CompletionIssue {
  message: string;
}

interface WorkerCompletionGate {
  observe(event: { tool: string; args: unknown; status: string; result?: unknown }): void;
  nextPrompt(output: string): Promise<string | undefined>;
}

export function createWriterCompletionGate(
  guard: WikiWriteGuard,
  options: {
    maxRepairRounds?: number;
    onTouched?: (location: string) => void;
    todo?: ReturnType<typeof createWriterTodoTracker>;
    templates?: WikiTemplatePack;
    catalogAvailable?: boolean;
  } = {},
): WorkerCompletionGate {
  const maxRepairRounds = options.maxRepairRounds ?? 6;
  assertRepairRounds(maxRepairRounds);
  const touched = new Set<string>();
  const reads: Array<Promise<EvidenceReceipt | undefined>> = [];
  const repair = createRepairLoop("Writer completion", maxRepairRounds,
    "Continue in this same session. Fix every issue in the batch, update the Todo, reread changed pages, and finish only after the next completion check passes.",
  );
  return {
    observe(event) {
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
      const issues = [
        ...await validateWriterEvidence(guard, touched, receipts),
        ...await validateWriterAssignment(guard, options.todo, options.templates, Boolean(options.catalogAvailable)),
      ];
      return repair(issues);
    },
  };
}

export function createReviewerCompletionGate(maxRepairRounds = 6): WorkerCompletionGate {
  assertRepairRounds(maxRepairRounds);
  const repair = createRepairLoop("Reviewer completion", maxRepairRounds,
    "Continue in this same read-only session. Return the complete review again with the required verdict as its first nonblank line.",
  );
  return {
    observe() {},
    async nextPrompt(output) {
      return repair(parseReviewVerdict(output) ? [] : [{
        message: "[review-verdict] The first nonblank line must be exactly `verdict: pass` or `verdict: changes_requested`.",
      }]);
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
): Promise<CompletionIssue[]> {
  const issues: CompletionIssue[] = [];
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
        message: [
          `[citation-unread] ${page}: ${resource}`,
          `  ${range
            ? `The successful read spans do not cover cited lines ${range}.`
            : "The cited pinned file was not successfully read in this writer session."}`,
          `  Suggested action: ${hasRange
            ? `Read lines ${range} from ${citation.path} (offset=${startLine}, limit=${endLine - startLine + 1}), then verify the claim or correct/remove the citation.`
            : `Read ${citation.path}, then verify the claim or replace/remove the unsupported citation.`}`,
        ].join("\n"),
      });
    }
  }
  return uniqueIssues(issues);
}

async function validateWriterAssignment(
  guard: WikiWriteGuard,
  todo: ReturnType<typeof createWriterTodoTracker> | undefined,
  templates: WikiTemplatePack | undefined,
  catalogAvailable: boolean,
): Promise<CompletionIssue[]> {
  if (!todo && !templates) return [];
  if (!guard.writeTarget) throw new Error("Writer completion requires a write target");
  const completed = await candidateTargetRevision(guard.candidateRoot, guard.writeTarget);
  const issues: CompletionIssue[] = [];
  if (todo) {
    try {
      todo.assertComplete(completed.files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({ message: `[writer-todo] ${message}` });
    }
  }
  if (templates) {
    const validation = await validateWikiTarget(
      guard.candidateRoot,
      guard.writeTarget,
      guard.sources,
      templates,
      { catalogAvailable },
    );
    issues.push(...validation.issues.map((issue) => ({
      message: `[${issue.code}] ${formatIssue(issue)}`,
    })));
  }
  return issues;
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

function uniqueIssues(issues: readonly CompletionIssue[]): CompletionIssue[] {
  return [...new Map(issues.map((issue) => [issue.message, issue])).values()];
}

function createRepairLoop(
  label: string,
  maxRepairRounds: number,
  instruction: string,
): (issues: readonly CompletionIssue[]) => string | undefined {
  let repairRounds = 0;
  return (issues) => {
    if (!issues.length) return undefined;
    const report = [
      `${label} validation found ${issues.length} issue${issues.length === 1 ? "" : "s"}. Fix all issues in this batch before finishing:`,
      ...issues.map((issue) => `- ${issue.message.replaceAll("\n", "\n  ")}`),
    ].join("\n");
    if (repairRounds >= maxRepairRounds) {
      throw new Error(`${label} repair did not converge after ${repairRounds} rounds.\n${report}`);
    }
    repairRounds += 1;
    return [
      report,
      instruction,
      `Repair round ${repairRounds} of ${maxRepairRounds}. All listed issues are from one exhaustive completion check.`,
    ].join("\n\n");
  };
}

function assertRepairRounds(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error("Worker repair rounds must be a positive integer");
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
