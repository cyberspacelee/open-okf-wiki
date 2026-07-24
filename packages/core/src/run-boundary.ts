/**
 * Run Boundary freeze entry (ADR 0019 / 0030).
 *
 * Fail-closed readiness for one Wiki Run: sources git+clean, Producer Skill
 * path + digest, durable Wiki Run Record. No Pi / framework deps.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RepositorySnapshot, WorkspaceConfig } from "@okf-wiki/contract";
import { probeLocalGit } from "./git.js";
import { makeTreeWritable } from "./immutable-tree.js";
import { materializeRepositorySnapshot } from "./repository-snapshot.js";
import { registerRunRecord } from "./run-store.js";
import { materializeSkillVersion, skillDigest } from "./skill-digest.js";
import { resolveSkillPath } from "./skill-path.js";
import { effectiveIgnoresForSource } from "./source-ignores.js";

/** Production always uses crypto.randomUUID(); tests may override allocation. */
let createRunId: () => string = () => randomUUID();

/**
 * Test-only override for run id allocation. Not re-exported from the package barrel.
 */
export function setFreezeWikiRunIdFactoryForTests(factory: (() => string) | undefined): void {
  createRunId = factory ?? (() => randomUUID());
}

export type FreezeWikiRunErrorCode =
  | "no_sources"
  | "source_not_git"
  | "source_dirty"
  | "skill_resolve";

export class FreezeWikiRunError extends Error {
  readonly code: FreezeWikiRunErrorCode;
  readonly sourceId?: string;
  readonly details?: unknown;

  constructor(
    code: FreezeWikiRunErrorCode,
    message: string,
    opts?: { sourceId?: string; details?: unknown; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FreezeWikiRunError";
    this.code = code;
    this.sourceId = opts?.sourceId;
    this.details = opts?.details;
  }
}

export type FrozenSourceSnapshot = RepositorySnapshot & {
  /** Absolute path to the immutable, run-owned ordinary-file tree. */
  path: string;
};

type ReadySource = RepositorySnapshot & {
  repositoryPath: string;
};

export type FreezeWikiRunInput = {
  workspace: WorkspaceConfig;
  sessionId: string;
  autoApprove?: boolean;
};

export type FrozenRunBoundary = {
  runId: string;
  skillPath: string;
  skillDigest: string;
  sources: FrozenSourceSnapshot[];
  /** sourceId → absolute path (for materialize). */
  sourcePathMap: Map<string, string>;
  /** Effective Source Ignores for Operations wrappers. */
  sourceIgnores: Map<string, readonly string[]>;
};

async function assertSourcesReady(workspace: WorkspaceConfig): Promise<ReadySource[]> {
  const sources = workspace.sources ?? [];
  if (sources.length === 0) {
    throw new FreezeWikiRunError(
      "no_sources",
      "workspace must have at least one source before starting a run",
    );
  }

  const frozen: ReadySource[] = [];
  for (const source of sources) {
    if (!source.id?.trim() || !source.path?.trim()) {
      throw new FreezeWikiRunError("no_sources", `source entry missing id or path`, {
        sourceId: source.id,
      });
    }
    const abs = path.resolve(source.path);
    const probe = await probeLocalGit(abs);
    if (!probe.isGit) {
      throw new FreezeWikiRunError(
        "source_not_git",
        `source "${source.id}" is not a git working tree: ${abs}`,
        { sourceId: source.id, details: probe },
      );
    }
    if (probe.dirty) {
      throw new FreezeWikiRunError(
        "source_dirty",
        `source "${source.id}" has a dirty git working tree; commit or stash before starting a run: ${abs}`,
        { sourceId: source.id, details: probe },
      );
    }
    if (!probe.head) {
      throw new FreezeWikiRunError(
        "source_not_git",
        `source "${source.id}" has no Git revision to freeze: ${abs}`,
        { sourceId: source.id, details: probe },
      );
    }
    frozen.push({
      id: source.id,
      repositoryPath: abs,
      revision: probe.head,
      effectiveIgnores: effectiveIgnoresForSource(source),
    });
  }
  return frozen;
}

async function freezeSkill(
  workspace: WorkspaceConfig,
): Promise<{ skillPath: string; skillDigest: string }> {
  try {
    const skillPath = await resolveSkillPath({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const digest = await skillDigest(skillPath);
    return { skillPath, skillDigest: digest };
  } catch (err) {
    if (err instanceof FreezeWikiRunError) throw err;
    throw new FreezeWikiRunError(
      "skill_resolve",
      err instanceof Error ? err.message : "failed to freeze producer skill",
      { cause: err },
    );
  }
}

/**
 * Fail-closed freeze for one Wiki Run: sources + Skill Version + Run Record.
 */
export async function freezeWikiRun(input: FreezeWikiRunInput): Promise<FrozenRunBoundary> {
  const workspace = input.workspace;
  const workspaceRoot = path.resolve(workspace.rootPath);
  const sources = await assertSourcesReady(workspace);
  const { skillPath: sourceSkillPath, skillDigest: digest } = await freezeSkill(workspace);

  const runId = createRunId();
  const runsRoot = path.join(workspaceRoot, ".okf-wiki", "runs");
  const runDir = path.join(runsRoot, runId);
  const sourcePathMap = new Map<string, string>();
  const frozenSources: FrozenSourceSnapshot[] = [];
  const skillPath = path.join(runDir, "skill");
  let ownsRunDir = false;

  try {
    await mkdir(runsRoot, { recursive: true });
    try {
      await mkdir(runDir);
      ownsRunDir = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        throw new Error(`run directory already exists: ${runDir}`, { cause: error });
      }
      throw error;
    }

    for (const source of sources) {
      const snapshotPath = path.join(runDir, "sources", source.id);
      await materializeRepositorySnapshot({
        repositoryPath: source.repositoryPath,
        revision: source.revision,
        destination: snapshotPath,
        effectiveIgnores: source.effectiveIgnores,
      });
      sourcePathMap.set(source.id, snapshotPath);
      frozenSources.push({
        id: source.id,
        revision: source.revision,
        effectiveIgnores: source.effectiveIgnores,
        path: snapshotPath,
      });
    }

    try {
      await materializeSkillVersion({
        sourceSkillPath,
        destination: skillPath,
        expectedDigest: digest,
      });
    } catch (error) {
      throw new FreezeWikiRunError(
        "skill_resolve",
        error instanceof Error ? error.message : "failed to materialize Producer Skill",
        { cause: error },
      );
    }

    await registerRunRecord(workspaceRoot, workspace.id, {
      autoApprove: input.autoApprove ?? false,
      skillPath,
      skillDigest: digest,
      sessionId: input.sessionId,
      sources: sources.map(({ repositoryPath: _repositoryPath, ...source }) => source),
      runId,
      status: "running",
    });
  } catch (error) {
    if (ownsRunDir) {
      await makeTreeWritable(runDir).catch(() => undefined);
      await rm(runDir, { recursive: true, force: true });
    }
    throw error;
  }

  const sourceIgnores = new Map<string, readonly string[]>(
    frozenSources.map((source) => [source.id, source.effectiveIgnores]),
  );

  return {
    runId,
    skillPath,
    skillDigest: digest,
    sources: frozenSources,
    sourcePathMap,
    sourceIgnores,
  };
}
