/**
 * Run Boundary freeze entry (ADR 0019 / 0030).
 *
 * Fail-closed readiness for one Wiki Run: sources git+clean, Producer Skill
 * path + digest, durable Wiki Run Record. No Pi / framework deps.
 */

import path from "node:path";
import type { WikiRunRecordStatus, WorkspaceConfig } from "@okf-wiki/contract";
import { probeLocalGit } from "./git.js";
import {
  type CreateRunOptions,
  createRun,
  registerRunRecord,
  updateRunRecord,
} from "./run-store.js";
import { skillDigest } from "./skill-digest.js";
import { resolveSkillPath } from "./skill-path.js";
import { buildSourceIgnoreMap } from "./source-ignores.js";

export type FreezeWikiRunErrorCode =
  | "no_sources"
  | "source_not_git"
  | "source_dirty"
  | "skill_resolve"
  | "invalid_run_id";

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

export type FrozenSourceSnapshot = {
  id: string;
  path: string;
  head?: string;
  branch?: string;
};

export type FreezeWikiRunInput = {
  workspace: WorkspaceConfig;
  /** When set, register this runId (Session-first). Otherwise createRun generates one. */
  runId?: string;
  sessionId?: string;
  autoApprove?: boolean;
  /** Initial record status (default running). Plan-gate starts may use awaiting_plan later via update. */
  status?: WikiRunRecordStatus;
  /**
   * Manual Retry: reuse prior frozen skill when present.
   * When skillPath is set without digest, digest is recomputed.
   */
  priorSkill?: {
    skillPath?: string;
    skillDigest?: string;
  };
};

export type FrozenRunBoundary = {
  runId: string;
  workspaceId: string;
  workspaceRoot: string;
  skillPath: string;
  skillDigest: string;
  sessionId?: string;
  autoApprove?: boolean;
  sources: FrozenSourceSnapshot[];
  /** sourceId → absolute path (for materialize). */
  sourcePathMap: Map<string, string>;
  /** Effective Source Ignores for Operations wrappers. */
  sourceIgnores: Map<string, readonly string[]>;
  recordStatus: WikiRunRecordStatus;
};

async function assertSourcesReady(workspace: WorkspaceConfig): Promise<FrozenSourceSnapshot[]> {
  const sources = workspace.sources ?? [];
  if (sources.length === 0) {
    throw new FreezeWikiRunError(
      "no_sources",
      "workspace must have at least one source before starting a run",
    );
  }

  const frozen: FrozenSourceSnapshot[] = [];
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
    frozen.push({
      id: source.id,
      path: abs,
      head: probe.head ?? undefined,
      branch: probe.branch ?? undefined,
    });
  }
  return frozen;
}

async function freezeSkill(
  workspace: WorkspaceConfig,
  prior?: FreezeWikiRunInput["priorSkill"],
): Promise<{ skillPath: string; skillDigest: string }> {
  try {
    let skillPath = prior?.skillPath?.trim();
    let digest = prior?.skillDigest?.trim();

    if (!skillPath) {
      skillPath = await resolveSkillPath({
        skillPath: workspace.skillPath,
        workspaceRoot: workspace.rootPath,
      });
    } else {
      // Ensure path still resolves (retry of frozen path).
      skillPath = await resolveSkillPath({
        skillPath,
        workspaceRoot: workspace.rootPath,
      });
    }

    if (!digest) {
      digest = await skillDigest(skillPath);
    }

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
  const { skillPath, skillDigest: digest } = await freezeSkill(workspace, input.priorSkill);

  const createOpts: CreateRunOptions = {
    autoApprove: input.autoApprove,
    skillPath,
    skillDigest: digest,
    sessionId: input.sessionId,
  };

  const status = input.status ?? "running";
  let runId: string;

  if (input.runId?.trim()) {
    const explicit = input.runId.trim();
    try {
      const record = await registerRunRecord(workspaceRoot, workspace.id, {
        ...createOpts,
        runId: explicit,
        status,
      });
      runId = record.runId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid runId/i.test(msg)) {
        throw new FreezeWikiRunError("invalid_run_id", msg, { cause: err });
      }
      throw err;
    }
  } else {
    const record = await createRun(workspaceRoot, workspace.id, createOpts);
    // createRun always starts as running; patch status if caller asked otherwise.
    if (status !== "running") {
      await updateRunRecord(workspaceRoot, record.runId, { status });
    }
    runId = record.runId;
  }

  const sourcePathMap = new Map<string, string>();
  for (const s of sources) {
    sourcePathMap.set(s.id, s.path);
  }

  const sourceIgnores = buildSourceIgnoreMap(workspace.sources ?? []);

  return {
    runId,
    workspaceId: workspace.id,
    workspaceRoot,
    skillPath,
    skillDigest: digest,
    sessionId: input.sessionId,
    autoApprove: input.autoApprove,
    sources,
    sourcePathMap,
    sourceIgnores,
    recordStatus: status,
  };
}
