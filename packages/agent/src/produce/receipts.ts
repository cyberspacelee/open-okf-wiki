/**
 * Host-side Analysis Receipt persistence for Domain/Leaf research.
 * Writers consume receipts from analysis/; children return summaries only.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AnalysisReceiptSchema,
  type AnalysisReceipt,
  type ReceiptStatus,
} from "@okf-wiki/contract";
import { writeAnalysisReceipt } from "@okf-wiki/core";

const SUMMARY_CAP = 4_000;
const FINDINGS_CAP = 24;
const FINDING_LEN = 500;

export function receiptsDir(runWorkDir: string): string {
  return path.join(path.resolve(runWorkDir), "analysis", "receipts");
}

export function safeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

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
 * Persist a research receipt under run workdir analysis/receipts and
 * workspace analysis scratch (same path when run lives under .okf-wiki/runs).
 */
export async function persistResearchReceipt(input: {
  workspaceRoot: string;
  runWorkDir: string;
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

  // Primary: workspace analysis scratch (canonical).
  let absPath: string;
  try {
    absPath = await writeAnalysisReceipt(input.workspaceRoot, receipt);
  } catch {
    // Fallback: write only under run workdir analysis/receipts.
    const dir = receiptsDir(input.runWorkDir);
    await mkdir(dir, { recursive: true });
    absPath = path.join(dir, `${safeNodeId(receipt.nodeId)}.json`);
    await writeFile(absPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

  // Also ensure run-workdir-relative receipts/ for agent discovery.
  const relDir = receiptsDir(input.runWorkDir);
  await mkdir(relDir, { recursive: true });
  const relAbs = path.join(relDir, `${safeNodeId(receipt.nodeId)}.json`);
  if (path.resolve(relAbs) !== path.resolve(absPath)) {
    await writeFile(relAbs, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

  const relativePath = `analysis/receipts/${safeNodeId(receipt.nodeId)}.json`;
  return { receiptPath: absPath, relativePath, receipt };
}

/**
 * Build a short index of receipt files for the Root writer prompt.
 */
export async function buildReceiptIndex(runWorkDir: string): Promise<string> {
  const dir = receiptsDir(runWorkDir);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return "No analysis receipts found under analysis/receipts/.";
  }
  if (names.length === 0) {
    return "No analysis receipts found under analysis/receipts/.";
  }
  const lines: string[] = ["Receipt files (read these before writing pages):"];
  for (const name of names.slice(0, 40)) {
    const rel = `analysis/receipts/${name}`;
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as { summary?: string; scope?: string; status?: string };
      const one = (parsed.summary ?? "").replace(/\s+/g, " ").slice(0, 160);
      lines.push(`- ${rel} [${parsed.status ?? "?"}] ${parsed.scope ?? ""} — ${one}`);
    } catch {
      lines.push(`- ${rel}`);
    }
  }
  if (names.length > 40) {
    lines.push(`… and ${names.length - 40} more`);
  }
  return lines.join("\n");
}
