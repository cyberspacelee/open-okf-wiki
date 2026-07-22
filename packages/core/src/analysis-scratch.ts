import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  AnalysisReceiptSchema,
  type AnalysisReceipt,
} from "@okf-wiki/contract";
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
  return path.join(
    path.resolve(workspaceRoot),
    WORKSPACE_DIR_NAME,
    "runs",
    safe,
    "analysis",
  );
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
  const safeNode = parsed.nodeId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
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
