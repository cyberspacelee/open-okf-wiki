/**
 * Produce-owned Analysis Receipt content builder for Domain/Leaf research.
 * Persistence is Core-only: one write to analysis/receipts/ via writeAnalysisReceipt.
 */

import {
  type AnalysisReceipt,
  AnalysisReceiptSchema,
  type ReceiptStatus,
} from "@okf-wiki/contract";
import { listAnalysisReceipts, safeReceiptNodeId, writeAnalysisReceipt } from "@okf-wiki/core";

const SUMMARY_CAP = 4_000;
const FINDINGS_CAP = 24;
const FINDING_LEN = 500;

function findingsFromSummary(summary: string): string[] {
  const lines = summary
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length >= 3);
  const out: string[] = [];
  for (const line of lines) {
    if (out.length >= FINDINGS_CAP) break;
    out.push(line.slice(0, FINDING_LEN));
  }
  if (out.length === 0 && summary.trim()) {
    out.push(summary.trim().slice(0, FINDING_LEN));
  }
  return out;
}

/**
 * Build research receipt fields and persist once through Core.
 * Canonical path: `{runWorkDir}/analysis/receipts/{nodeId}.json`
 * (= `{workspace}/.okf-wiki/runs/{runId}/analysis/receipts/...`).
 */
export async function persistResearchReceipt(input: {
  workspaceRoot: string;
  runId: string;
  nodeId: string;
  parentId: string | null;
  scope: string;
  summary: string;
  status?: ReceiptStatus;
  childReceipts?: string[];
  openQuestions?: string[];
}): Promise<{ receiptPath: string; relativePath: string; receipt: AnalysisReceipt }> {
  const receipt = AnalysisReceiptSchema.parse({
    version: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    parentId: input.parentId,
    attempt: 1,
    status: input.status ?? "complete",
    scope: input.scope.slice(0, 2000),
    summary: input.summary.slice(0, SUMMARY_CAP),
    findings: findingsFromSummary(input.summary),
    evidence: [],
    childReceipts: input.childReceipts ?? [],
    openQuestions: input.openQuestions ?? [],
  });

  const absPath = await writeAnalysisReceipt(input.workspaceRoot, receipt);
  const relativePath = `analysis/receipts/${safeReceiptNodeId(receipt.nodeId)}.json`;
  return { receiptPath: absPath, relativePath, receipt };
}

/**
 * Build a short index of receipt files for the Root writer prompt.
 * Lists via Core (same canonical analysis/receipts/ locality as writes).
 */
export async function buildReceiptIndex(workspaceRoot: string, runId: string): Promise<string> {
  const list = await listAnalysisReceipts(workspaceRoot, runId);
  if (list.length === 0) {
    return "No analysis receipts found under analysis/receipts/.";
  }
  const lines: string[] = ["Receipt files (read these before writing pages):"];
  for (const item of list.slice(0, 40)) {
    const rel = `analysis/${item.relativePath}`;
    const one = item.summary.replace(/\s+/g, " ").slice(0, 160);
    lines.push(`- ${rel} [${item.status}] ${item.scope} — ${one}`);
  }
  if (list.length > 40) {
    lines.push(`… and ${list.length - 40} more`);
  }
  return lines.join("\n");
}
