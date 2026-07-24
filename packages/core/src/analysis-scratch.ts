import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AnalysisReceipt, AnalysisReceiptSchema } from "@okf-wiki/contract";
import { isPathInside, WORKSPACE_DIR_NAME } from "./workspace-store.js";

/**
 * Analysis dir for one Wiki Run under the run workdir (ADR 0030):
 * `{root}/.okf-wiki/runs/{runId}/analysis`
 *
 * Co-located with Staging Wiki (`…/wiki`) and source mounts. Not the
 * legacy `{root}/.okf-wiki/analysis/{runId}` tree (deleted; no-compat).
 */
export function analysisScratchDir(workspaceRoot: string, runId: string): string {
  const safe = runId.replace(/[/\\]/g, "_");
  return path.join(path.resolve(workspaceRoot), WORKSPACE_DIR_NAME, "runs", safe, "analysis");
}

/** Subdir preferred by Host research fan-out for agent discovery. */
export function analysisReceiptsDir(workspaceRoot: string, runId: string): string {
  return path.join(analysisScratchDir(workspaceRoot, runId), "receipts");
}

export function safeReceiptNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

/**
 * Write a validated Analysis Receipt under the run's analysis scratch.
 * Returns the absolute path of the written JSON file.
 */
export async function writeAnalysisReceipt(
  workspaceRoot: string,
  receipt: AnalysisReceipt,
): Promise<string> {
  const parsed = AnalysisReceiptSchema.parse(receipt);
  const dir = analysisScratchDir(workspaceRoot, parsed.runId);
  const root = path.resolve(workspaceRoot);
  if (!isPathInside(root, dir)) {
    throw new Error("analysis scratch escapes workspace root");
  }
  await mkdir(dir, { recursive: true });
  const safeNode = safeReceiptNodeId(parsed.nodeId);
  const filePath = path.join(dir, `${safeNode}.json`);
  if (!isPathInside(dir, filePath)) {
    throw new Error("receipt path escapes analysis scratch");
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, filePath);
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
 * List analysis receipts for a run (analysis/*.json + analysis/receipts/*.json).
 * Dedupes by nodeId; prefers the receipts/ copy when both exist.
 */
export async function listAnalysisReceipts(
  workspaceRoot: string,
  runId: string,
): Promise<AnalysisReceiptSummary[]> {
  const analysisDir = analysisScratchDir(workspaceRoot, runId);
  const receiptsSub = analysisReceiptsDir(workspaceRoot, runId);
  const byNode = new Map<string, AnalysisReceiptSummary>();

  async function scan(dir: string, relPrefix: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === "spec.json" || name === "defects.json") {
        continue;
      }
      const abs = path.join(dir, name);
      const receipt = await tryReadReceiptFile(abs);
      if (!receipt) continue;
      byNode.set(receipt.nodeId, {
        nodeId: receipt.nodeId,
        parentId: receipt.parentId,
        status: receipt.status,
        scope: receipt.scope,
        summary: receipt.summary.slice(0, 500),
        relativePath: `${relPrefix}${name}`.replace(/\\/g, "/"),
        findingsCount: receipt.findings?.length ?? 0,
        childReceipts: receipt.childReceipts ?? [],
      });
    }
  }

  // Base analysis first, then receipts/ overwrites (preferred).
  await scan(analysisDir, "");
  await scan(receiptsSub, "receipts/");

  return [...byNode.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

/**
 * Load one receipt by nodeId (or safe filename stem).
 * Searches analysis/receipts/ then analysis/.
 */
export async function readAnalysisReceipt(
  workspaceRoot: string,
  runId: string,
  nodeId: string,
): Promise<AnalysisReceipt | null> {
  const safe = safeReceiptNodeId(nodeId);
  const candidates = [
    path.join(analysisReceiptsDir(workspaceRoot, runId), `${safe}.json`),
    path.join(analysisScratchDir(workspaceRoot, runId), `${safe}.json`),
    // Allow callers to pass relative path like receipts/foo.json
    path.join(analysisScratchDir(workspaceRoot, runId), nodeId.replace(/^\/+/, "")),
  ];
  const root = path.resolve(workspaceRoot);
  for (const abs of candidates) {
    if (!isPathInside(root, abs)) continue;
    const receipt = await tryReadReceiptFile(abs);
    if (receipt) return receipt;
  }
  return null;
}
