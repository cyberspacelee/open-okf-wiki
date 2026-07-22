/**
 * Living WikiRunSpec on disk under the run analysis scratch.
 * Root may replan during produce; Host scorers read the same file.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WikiRunSpecSchema,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import { analysisScratchDir } from "@okf-wiki/core";

export const SPEC_FILE_NAME = "spec.json";
export const DEFECTS_FILE_NAME = "defects.json";

export function runAnalysisDir(workspaceRoot: string, runId: string): string {
  return analysisScratchDir(workspaceRoot, runId);
}

export function specPath(workspaceRoot: string, runId: string): string {
  return path.join(runAnalysisDir(workspaceRoot, runId), SPEC_FILE_NAME);
}

export function defectsPath(workspaceRoot: string, runId: string): string {
  return path.join(runAnalysisDir(workspaceRoot, runId), DEFECTS_FILE_NAME);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function writeWikiRunSpec(
  workspaceRoot: string,
  runId: string,
  spec: WikiRunSpec,
): Promise<string> {
  const parsed = WikiRunSpecSchema.parse(spec);
  const filePath = specPath(workspaceRoot, runId);
  await atomicWriteJson(filePath, parsed);
  return filePath;
}

export async function readWikiRunSpec(
  workspaceRoot: string,
  runId: string,
): Promise<WikiRunSpec | null> {
  const filePath = specPath(workspaceRoot, runId);
  try {
    const raw = await readFile(filePath, "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function appendSpecChangelog(
  workspaceRoot: string,
  runId: string,
  entry: string,
): Promise<WikiRunSpec | null> {
  const current = await readWikiRunSpec(workspaceRoot, runId);
  if (!current) {
    return null;
  }
  const next = WikiRunSpecSchema.parse({
    ...current,
    changelog: [...(current.changelog ?? []), entry.slice(0, 500)].slice(-40),
  });
  await writeWikiRunSpec(workspaceRoot, runId, next);
  return next;
}
