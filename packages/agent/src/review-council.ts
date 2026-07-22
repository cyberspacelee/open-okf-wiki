/**
 * Host-owned review council: one or more independent reviewers → MergedDefectReport.
 */

import type { Agent } from "@mastra/core/agent";
import type { MergedDefectReport } from "@okf-wiki/contract";
import {
  mergeDefectReports,
  parseDefectReportFromText,
  writeMergedDefects,
} from "./defects.js";
import { writeAnalysisReceipt } from "@okf-wiki/core";

export async function runReviewCouncil(input: {
  reviewers: Agent[];
  pages: string[];
  maxSteps: number;
  workspaceRoot: string;
  runId: string;
  abortSignal?: AbortSignal;
  memoryOption?: { thread: string; resource: string };
  round?: number;
}): Promise<MergedDefectReport> {
  const round = input.round ?? 1;
  const pageList = input.pages.join(", ");
  const prompt =
    `Review staged wiki pages: ${pageList}. ` +
    "Return either the exact token NO_DEFECTS, or a fenced JSON object:\n" +
    "```json\n" +
    '{ "clean": false, "defects": [{ "severity": "blocking|major|minor", "code": "string", "path": "page.md", "issue": "string", "suggestedFix": "string" }] }\n' +
    "```\n" +
    "Severity blocking means must fix before publish. Do not write wiki pages.";

  const reports = await Promise.all(
    input.reviewers.map(async (reviewer, index) => {
      const reviewerId =
        (reviewer as { id?: string }).id ?? `reviewer-${index + 1}`;
      try {
        const result = await reviewer.generate(
          [{ role: "user", content: prompt }],
          {
            maxSteps: input.maxSteps,
            ...(input.memoryOption
              ? {
                  memory: {
                    thread: `wiki-run-${input.memoryOption.thread}-${reviewerId}-r${round}`,
                    resource: `wiki-run-${input.memoryOption.resource}`,
                  },
                }
              : {}),
            ...(input.abortSignal
              ? { abortSignal: input.abortSignal }
              : {}),
          },
        );
        const text = result.text ?? "";
        const report = parseDefectReportFromText(text, reviewerId);
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
      } catch (error) {
        return parseDefectReportFromText(
          `blocking: reviewer ${reviewerId} failed: ${error instanceof Error ? error.message : String(error)}`,
          reviewerId,
        );
      }
    }),
  );

  const merged = mergeDefectReports(reports);
  await writeMergedDefects(input.workspaceRoot, input.runId, merged);
  return merged;
}
