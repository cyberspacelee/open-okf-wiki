/**
 * Host-owned review council → MergedDefectReport.
 * Pi path: pure merge of pre-generated reviewer texts (no Mastra Agent).
 */

import type { MergedDefectReport } from "@okf-wiki/contract";
import {
  mergeDefectReports,
  parseDefectReportFromText,
  writeMergedDefects,
} from "./defects.js";
import { writeAnalysisReceipt } from "@okf-wiki/core";

export type ReviewerOutput = {
  id: string;
  text: string;
};

/**
 * Merge independent reviewer outputs into a MergedDefectReport and persist.
 * Callers (Pi sessions later) supply raw reviewer text; this host owns merge + receipts.
 */
export async function runReviewCouncil(input: {
  reviewers: ReviewerOutput[];
  pages: string[];
  workspaceRoot: string;
  runId: string;
  round?: number;
}): Promise<MergedDefectReport> {
  const round = input.round ?? 1;
  const pageList = input.pages.join(", ");

  const reports = await Promise.all(
    input.reviewers.map(async (reviewer, index) => {
      const reviewerId = reviewer.id?.trim() || `reviewer-${index + 1}`;
      const report = parseDefectReportFromText(reviewer.text ?? "", reviewerId);
      try {
        await writeAnalysisReceipt(input.workspaceRoot, {
          version: 1,
          runId: input.runId,
          nodeId: `${reviewerId}-r${round}`,
          parentId: "root",
          attempt: round,
          status: "complete",
          scope: `staged pages: ${pageList}`,
          summary: report.summary ?? (report.clean ? "NO_DEFECTS" : "defects"),
          findings: report.clean
            ? ["NO_DEFECTS"]
            : report.defects.map(
                (d) => `[${d.severity}] ${d.path ?? "?"}: ${d.issue}`,
              ),
          evidence: [],
          childReceipts: [],
          openQuestions: [],
        });
      } catch {
        // best-effort
      }
      return report;
    }),
  );

  const merged = mergeDefectReports(reports);
  await writeMergedDefects(input.workspaceRoot, input.runId, merged);
  return merged;
}
