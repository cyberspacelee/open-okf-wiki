import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type AnalysisReceipt, AnalysisReceiptSchema } from "@okf-wiki/contract";
import { atomicWriteJson } from "./atomic-write.js";
import { isPathInside, WORKSPACE_DIR_NAME } from "./workspace-store.js";

/**
 * Analysis dir for one Wiki Run under the run workdir (ADR 0030):
 * `{root}/.okf-wiki/runs/{runId}/analysis`
 *
 * Co-located with Staging Wiki (`…/wiki`) and source mounts. Holds
 * `spec.json`, `defects.json`, and the `receipts/` subdirectory.
 */
export function analysisScratchDir(workspaceRoot: string, runId: string): string {
  const safe = runId.replace(/[/\\]/g, "_");
  return path.join(path.resolve(workspaceRoot), WORKSPACE_DIR_NAME, "runs", safe, "analysis");
}

/**
 * Canonical Analysis Receipt directory (sole write/list locality):
 * `{root}/.okf-wiki/runs/{runId}/analysis/receipts`
 * (= `{runWorkDir}/analysis/receipts` when the run lives under `.okf-wiki/runs/`).
 */
export function analysisReceiptsDir(workspaceRoot: string, runId: string): string {
  return path.join(analysisScratchDir(workspaceRoot, runId), "receipts");
}

export function safeReceiptNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

/**
 * Write a validated Analysis Receipt under the run's analysis/receipts.
 * Single write authority — one file, no dual-location copies.
 * Returns the absolute path of the written JSON file.
 */
export async function writeAnalysisReceipt(
  workspaceRoot: string,
  receipt: AnalysisReceipt,
): Promise<string> {
  const parsed = AnalysisReceiptSchema.parse(receipt);
  const dir = analysisReceiptsDir(workspaceRoot, parsed.runId);
  const root = path.resolve(workspaceRoot);
  if (!isPathInside(root, dir)) {
    throw new Error("analysis receipts dir escapes workspace root");
  }
  const safeNode = safeReceiptNodeId(parsed.nodeId);
  const filePath = path.join(dir, `${safeNode}.json`);
  if (!isPathInside(dir, filePath)) {
    throw new Error("receipt path escapes analysis receipts dir");
  }
  await atomicWriteJson(filePath, parsed);
  return filePath;
}

export type AnalysisReceiptSummary = {
  nodeId: string;
  parentId: string | null;
  status: AnalysisReceipt["status"];
  scope: string;
  summary: string;
  /** Relative path under run analysis (e.g. receipts/domain-core.json). */
  relativePath: string;
  findingsCount: number;
  childReceipts: string[];
};

async function tryReadReceiptFile(absPath: string): Promise<AnalysisReceipt | null> {
  try {
    const raw = await readFile(absPath, "utf8");
    return AnalysisReceiptSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * List analysis receipts for a run from the canonical analysis/receipts/ dir only.
 */
export async function listAnalysisReceipts(
  workspaceRoot: string,
  runId: string,
): Promise<AnalysisReceiptSummary[]> {
  const receiptsDir = analysisReceiptsDir(workspaceRoot, runId);
  const byNode = new Map<string, AnalysisReceiptSummary>();

  let names: string[];
  try {
    names = await readdir(receiptsDir);
  } catch {
    return [];
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const abs = path.join(receiptsDir, name);
    const receipt = await tryReadReceiptFile(abs);
    if (!receipt) continue;
    byNode.set(receipt.nodeId, {
      nodeId: receipt.nodeId,
      parentId: receipt.parentId,
      status: receipt.status,
      scope: receipt.scope,
      summary: receipt.summary.slice(0, 500),
      relativePath: `receipts/${name}`.replace(/\\/g, "/"),
      findingsCount: receipt.findings?.length ?? 0,
      childReceipts: receipt.childReceipts ?? [],
    });
  }

  return [...byNode.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

/**
 * Load one receipt by nodeId (or safe filename stem) from analysis/receipts/.
 * Also accepts a path relative to the analysis dir (e.g. receipts/foo.json).
 */
export async function readAnalysisReceipt(
  workspaceRoot: string,
  runId: string,
  nodeId: string,
): Promise<AnalysisReceipt | null> {
  const safe = safeReceiptNodeId(nodeId);
  const analysisDir = analysisScratchDir(workspaceRoot, runId);
  const receiptsDir = analysisReceiptsDir(workspaceRoot, runId);
  const root = path.resolve(workspaceRoot);
  const candidates = [
    path.join(receiptsDir, `${safe}.json`),
    // Explicit relative path under analysis (e.g. receipts/foo.json from childReceipts).
    path.join(analysisDir, nodeId.replace(/^\/+/, "")),
  ];
  for (const abs of candidates) {
    if (!isPathInside(root, abs) || !isPathInside(analysisDir, abs)) continue;
    const receipt = await tryReadReceiptFile(abs);
    if (receipt) return receipt;
  }
  return null;
}
