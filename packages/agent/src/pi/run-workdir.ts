/**
 * Materialise a Pi-friendly single-cwd layout for one Wiki Run (ADR 0030).
 *
 * {runWorkDir}/
 *   sources/<id>/  → snapshot roots (symlink)
 *   skill/         → Producer Skill (symlink)
 *   wiki/          → Staging Wiki (directory)
 *   analysis/      → spec + receipts
 */

import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

export type RunWorkdirLayout = {
  runWorkDir: string;
  sourcesDir: string;
  skillDir: string;
  wikiDir: string;
  analysisDir: string;
  /** sourceId → absolute path under sources/ */
  sourceMounts: Map<string, string>;
};

export type MaterializeRunWorkdirInput = {
  runWorkDir: string;
  /** source id → absolute snapshot/checkout path */
  sources: ReadonlyMap<string, string>;
  /** absolute Producer Skill root */
  skillRoot: string;
  /** when true, wipe runWorkDir first */
  reset?: boolean;
};

async function ensureSymlink(target: string, linkPath: string): Promise<void> {
  try {
    const st = await lstat(linkPath);
    if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
      await rm(linkPath, { recursive: true, force: true });
    }
  } catch {
    // missing is fine
  }
  await symlink(target, linkPath, "junction");
}

/**
 * Create the run workdir tree. Uses directory junctions/symlinks for sources and skill.
 * On Windows, `junction` avoids needing elevated symlink privileges for directories.
 */
export async function materializeRunWorkdir(
  input: MaterializeRunWorkdirInput,
): Promise<RunWorkdirLayout> {
  const runWorkDir = path.resolve(input.runWorkDir);
  if (input.reset) {
    await rm(runWorkDir, { recursive: true, force: true });
  }

  const sourcesDir = path.join(runWorkDir, "sources");
  const skillDir = path.join(runWorkDir, "skill");
  const wikiDir = path.join(runWorkDir, "wiki");
  const analysisDir = path.join(runWorkDir, "analysis");

  await mkdir(sourcesDir, { recursive: true });
  await mkdir(wikiDir, { recursive: true });
  await mkdir(analysisDir, { recursive: true });

  const sourceMounts = new Map<string, string>();
  for (const [id, abs] of input.sources) {
    const safeId = id.replace(/[/\\]/g, "_");
    const mount = path.join(sourcesDir, safeId);
    await ensureSymlink(path.resolve(abs), mount);
    sourceMounts.set(id, mount);
  }

  await ensureSymlink(path.resolve(input.skillRoot), skillDir);

  return {
    runWorkDir,
    sourcesDir,
    skillDir,
    wikiDir,
    analysisDir,
    sourceMounts,
  };
}

/** Relative paths the model should use in prompts. */
export function runWorkdirPromptPaths(layout: RunWorkdirLayout): string {
  const sourceLines = [...layout.sourceMounts.keys()]
    .map((id) => `  - sources/${id.replace(/[/\\]/g, "_")}/`)
    .join("\n");
  return [
    "Working directory layout (all tool paths are relative to cwd):",
    sourceLines || "  - (no sources)",
    "  - skill/          Producer Skill (read-only)",
    "  - wiki/           Staging Wiki (writable only in write roles)",
    "  - analysis/       Run analysis (spec.json, receipts)",
  ].join("\n");
}
