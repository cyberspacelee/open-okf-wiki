/**
 * Structured defect reports, merge, and deterministic publishability scoring.
 * Fail-closed: blocking defects prevent publish.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type DefectItem,
  type DefectReport,
  DefectReportSchema,
  type DefectSeverity,
  type MergedDefectReport,
  MergedDefectReportSchema,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import { scanWikiTree, validateWikiTree } from "@okf-wiki/core";
import { defectsPath } from "./spec-store.js";

const SEVERITY_RANK: Record<DefectSeverity, number> = {
  blocking: 3,
  major: 2,
  minor: 1,
};

export function parseDefectReportFromText(text: string, reviewerId: string): DefectReport {
  const raw = text?.trim() ?? "";
  if (!raw) {
    return DefectReportSchema.parse({
      reviewerId,
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "empty_review",
          issue: "Reviewer returned empty output",
        },
      ],
      summary: "empty review",
    });
  }

  if (/NO_DEFECTS/i.test(raw) && !/severity\s*[:=]\s*blocking/i.test(raw)) {
    return DefectReportSchema.parse({
      reviewerId,
      clean: true,
      defects: [],
      summary: "NO_DEFECTS",
    });
  }

  // Prefer fenced JSON DefectReport.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1]!) as unknown;
      const asReport = DefectReportSchema.safeParse({
        ...(typeof parsed === "object" && parsed ? parsed : {}),
        reviewerId,
      });
      if (asReport.success) {
        return asReport.data;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { defects?: unknown }).defects)
      ) {
        const defects = normalizeDefectItems((parsed as { defects: unknown[] }).defects);
        return DefectReportSchema.parse({
          reviewerId,
          clean: defects.length === 0,
          defects,
          summary:
            typeof (parsed as { summary?: unknown }).summary === "string"
              ? String((parsed as { summary: string }).summary).slice(0, 2000)
              : raw.slice(0, 500),
        });
      }
    } catch {
      // fall through
    }
  }

  // Line-oriented: severity: blocking | path | issue
  const defects: DefectItem[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || /^#{1,3}\s/.test(t) || /NO_DEFECTS/i.test(t)) {
      continue;
    }
    const sevMatch = t.match(/\b(blocking|major|minor)\b/i);
    const pathMatch = t.match(/`([^`]+\.md)`|([A-Za-z0-9_./-]+\.md)/);
    const severity = (sevMatch?.[1]?.toLowerCase() ?? "major") as DefectSeverity;
    const issue = t.replace(/^[-*]\s*/, "").slice(0, 2000);
    if (issue.length < 3) {
      continue;
    }
    defects.push({
      severity: SEVERITY_RANK[severity] ? severity : "major",
      code: "review_finding",
      path: pathMatch?.[1] ?? pathMatch?.[2],
      issue,
    });
  }

  if (defects.length === 0 && !/NO_DEFECTS/i.test(raw)) {
    defects.push({
      severity: "blocking",
      code: "unparsed_review",
      issue: raw.slice(0, 500),
    });
  }

  return DefectReportSchema.parse({
    reviewerId,
    clean: defects.length === 0,
    defects,
    summary: raw.slice(0, 500),
  });
}

function normalizeDefectItems(items: unknown[]): DefectItem[] {
  const out: DefectItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    const severityRaw = String(o.severity ?? "major").toLowerCase();
    const severity = (
      severityRaw === "blocking" || severityRaw === "major" || severityRaw === "minor"
        ? severityRaw
        : "major"
    ) as DefectSeverity;
    const issue = String(o.issue ?? o.message ?? "").trim();
    if (!issue) {
      continue;
    }
    out.push({
      severity,
      code: String(o.code ?? "review_finding").slice(0, 80),
      path: o.path ? String(o.path).slice(0, 200) : undefined,
      issue: issue.slice(0, 2000),
      suggestedFix: o.suggestedFix ? String(o.suggestedFix).slice(0, 2000) : undefined,
    });
  }
  return out;
}

export function mergeDefectReports(reports: DefectReport[]): MergedDefectReport {
  const defects: DefectItem[] = [];
  const reviewerIds: string[] = [];
  for (const r of reports) {
    reviewerIds.push(r.reviewerId);
    for (const d of r.defects) {
      defects.push(d);
    }
  }
  // Dedupe by severity+path+issue prefix
  const seen = new Set<string>();
  const unique = defects.filter((d) => {
    const key = `${d.severity}|${d.path ?? ""}|${d.issue.slice(0, 80)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return MergedDefectReportSchema.parse({
    clean: unique.length === 0,
    defects: unique,
    reviewerIds,
    summary:
      unique.length === 0
        ? "NO_DEFECTS"
        : `${unique.length} defect(s) from ${reviewerIds.length} reviewer(s)`,
  });
}

export function hasBlockingDefects(
  merged: MergedDefectReport,
  blockingSeverities: DefectSeverity[] = ["blocking"],
): boolean {
  const set = new Set(blockingSeverities);
  return merged.defects.some((d) => set.has(d.severity));
}

export async function writeMergedDefects(
  workspaceRoot: string,
  runId: string,
  report: MergedDefectReport,
): Promise<string> {
  const parsed = MergedDefectReportSchema.parse(report);
  const filePath = defectsPath(workspaceRoot, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return filePath;
}

export async function readMergedDefects(
  workspaceRoot: string,
  runId: string,
): Promise<MergedDefectReport | null> {
  try {
    const raw = await readFile(defectsPath(workspaceRoot, runId), "utf8");
    return MergedDefectReportSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export type PublishabilityResult = {
  publishable: boolean;
  reasons: string[];
  pages: string[];
  defects: MergedDefectReport | null;
};

/**
 * Deterministic scorer: critical pages exist, mechanical validate ok,
 * no blocking defects when review is required.
 */
export async function evaluateWikiPublishable(input: {
  wikiRoot: string;
  workspaceRoot: string;
  runId: string;
  sources: Array<{ id: string; path: string }>;
  spec?: WikiRunSpec | null;
  /** When true (default), missing defects file fails if reviewRequired. */
  requireReviewReceipt?: boolean;
}): Promise<PublishabilityResult> {
  const reasons: string[] = [];
  const pages = (await scanWikiTree(input.wikiRoot)).files
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath.toLowerCase().endsWith(".md"));
  if (pages.length === 0) {
    reasons.push("no staged wiki pages");
  }

  const spec = input.spec;
  if (spec?.pages?.length) {
    const pageSet = new Set(pages.map((p) => p.replace(/^\.?\//, "")));
    for (const p of spec.pages) {
      if (p.critical === false) {
        continue;
      }
      const norm = p.path.replace(/^\.?\//, "");
      if (!pageSet.has(norm)) {
        reasons.push(`missing critical page: ${norm}`);
      }
    }
  }

  const validation = await validateWikiTree(input.wikiRoot, {
    sources: input.sources,
  });
  if (!validation.ok) {
    reasons.push(`validation: ${validation.errors.slice(0, 10).join("; ")}`);
  }

  const defects = await readMergedDefects(input.workspaceRoot, input.runId);
  const reviewRequired = spec?.acceptance?.reviewRequired !== false;
  const requireReceipt = input.requireReviewReceipt !== false;

  if (reviewRequired) {
    if (!defects && requireReceipt) {
      reasons.push("review required but defects.json missing");
    } else if (defects) {
      const blocking = spec?.acceptance?.blockingSeverities ?? ["blocking"];
      if (hasBlockingDefects(defects, blocking as DefectSeverity[])) {
        reasons.push(
          `blocking defects remain (${defects.defects.filter((d) => (blocking as string[]).includes(d.severity)).length})`,
        );
      } else if (!defects.clean && blocking.includes("major" as DefectSeverity)) {
        // already covered by hasBlockingDefects when major is blocking
      }
    }
  }

  return {
    publishable: reasons.length === 0,
    reasons,
    pages,
    defects,
  };
}
