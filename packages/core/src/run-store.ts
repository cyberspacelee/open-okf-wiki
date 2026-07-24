import { lstat, readdir, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import {
  type RepositorySnapshot,
  type StoredRunRecord,
  StoredRunRecordSchema,
  type WikiRunRecordStatus,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import { atomicCreateJson, atomicWriteJson } from "./atomic-write.js";
import { makeTreeWritable } from "./immutable-tree.js";
import { isPathInside } from "./paths.js";
import { WORKSPACE_DIR_NAME } from "./workspace-store.js";

const RUNS_DIR_NAME = "runs";

/** Absolute path to `{root}/.okf-wiki/runs`. */
function runsDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME, RUNS_DIR_NAME);
}

/** Absolute path to `{root}/.okf-wiki/runs/{runId}.json`. */
function runRecordPath(rootPath: string, runId: string): string {
  return path.join(runsDir(rootPath), `${runId}.json`);
}

export type RegisterRunOptions = {
  runId: string;
  status?: WikiRunRecordStatus;
  sessionId: string;
  autoApprove: boolean;
  /** Immutable, run-owned Producer Skill copy. */
  skillPath: string;
  skillDigest: string;
  sources: RepositorySnapshot[];
  error?: string | null;
  spec?: WikiRunSpec | null;
  pages?: string[];
  summary?: string | null;
};

/**
 * Persist a run record with an explicit runId and optional status.
 * Used when the real `wiki_produce` tool already chose the run id and needs a
 * Wiki Run Record for its frozen inputs and evolving outcome (ADR 0032).
 * Staging Wiki lives under the run workdir (`…/runs/<runId>/wiki`).
 */
export async function registerRunRecord(
  rootPath: string,
  workspaceId: string,
  options: RegisterRunOptions,
): Promise<StoredRunRecord> {
  const resolvedRoot = path.resolve(rootPath);
  const dir = runsDir(resolvedRoot);
  if (!isPathInside(resolvedRoot, dir)) {
    throw new Error("refusing to write runs outside workspace meta directory");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.runId) || options.runId.includes("..")) {
    throw new Error("invalid runId");
  }
  const expectedSkillPath = path.join(
    resolvedRoot,
    WORKSPACE_DIR_NAME,
    RUNS_DIR_NAME,
    options.runId,
    "skill",
  );
  if (path.resolve(options.skillPath) !== expectedSkillPath) {
    throw new Error(`skillPath must be the run-owned Skill path: ${expectedSkillPath}`);
  }

  const now = new Date().toISOString();
  const record: StoredRunRecord = {
    schema: "okf.wiki-run/v2",
    runId: options.runId,
    workspaceId,
    sessionId: options.sessionId.trim(),
    status: options.status ?? "running",
    autoApprove: options.autoApprove,
    error: options.error ?? null,
    skillPath: options.skillPath.trim(),
    skillDigest: options.skillDigest.trim(),
    sources: options.sources,
    spec: options.spec ?? null,
    pages: options.pages ?? [],
    summary: options.summary ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const parsed = StoredRunRecordSchema.parse(record);
  await atomicCreateJson(runRecordPath(resolvedRoot, options.runId), parsed);
  return parsed;
}

export type RunRecordPatch = {
  status?: WikiRunRecordStatus;
  error?: string | null;
  spec?: WikiRunSpec | null;
  pages?: string[];
  summary?: string | null;
};

/** Thrown when a status transition conflicts with the current record (e.g. cancel after finish). */
export class RunStatusConflictError extends Error {
  readonly record: StoredRunRecord;

  constructor(record: StoredRunRecord, message: string) {
    super(message);
    this.name = "RunStatusConflictError";
    this.record = record;
  }
}

/**
 * Merge a patch into an existing run record and persist it.
 *
 * Concurrency rules for cancel races:
 * - A `cancelled` record is never overwritten by a different status (cancel wins).
 * - `cancelled` may only be applied while the record is still `running`
 *   (agent/HITL finished first wins; cancel returns conflict).
 */
export async function updateRunRecord(
  rootPath: string,
  runId: string,
  patch: RunRecordPatch,
): Promise<StoredRunRecord> {
  const allowedPatchKeys = new Set(["status", "error", "spec", "pages", "summary"]);
  for (const key of Object.keys(patch)) {
    if (!allowedPatchKeys.has(key)) {
      throw new Error(`cannot patch frozen Wiki Run Record field: ${key}`);
    }
  }

  const existing = await loadRun(rootPath, runId);
  if (!existing) {
    throw new Error(`run not found: ${runId}`);
  }

  // Cancel wins races against late agent finalization / auto-publish.
  if (existing.status === "cancelled" && patch.status && patch.status !== "cancelled") {
    return existing;
  }

  // Cancel while running or waiting on operator (plan / publish HITL);
  // idempotent if already cancelled.
  if (
    patch.status === "cancelled" &&
    !["running", "awaiting_plan", "awaiting_publication", "cancelled"].includes(existing.status)
  ) {
    throw new RunStatusConflictError(existing, `run is not running (status: ${existing.status})`);
  }

  const next: StoredRunRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
  };

  if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.error !== undefined) {
    next.error = patch.error;
  }
  if (Array.isArray(patch.pages)) {
    next.pages = patch.pages;
  }
  if (patch.summary !== undefined) {
    next.summary = patch.summary;
  }
  if (patch.spec !== undefined) {
    next.spec = patch.spec;
  }

  // Clear stale error when transitioning to a successful terminal status.
  if (
    patch.status === "awaiting_publication" ||
    patch.status === "awaiting_plan" ||
    patch.status === "published"
  ) {
    next.error = null;
  }

  const parsed = StoredRunRecordSchema.parse(next);
  await atomicWriteJson(runRecordPath(rootPath, runId), parsed);
  return parsed;
}

export async function loadRun(rootPath: string, runId: string): Promise<StoredRunRecord | null> {
  if (!runId || runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    return null;
  }
  const filePath = runRecordPath(rootPath, runId);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = StoredRunRecordSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function listRuns(rootPath: string): Promise<StoredRunRecord[]> {
  const dir = runsDir(rootPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const runs: StoredRunRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const runId = name.slice(0, -".json".length);
    const record = await loadRun(rootPath, runId);
    if (record) {
      runs.push(record);
    }
  }

  runs.sort((a, b) => {
    if (a.createdAt === b.createdAt) {
      return a.runId < b.runId ? 1 : -1;
    }
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return runs;
}

/**
 * Delete v2 Run Records and run-owned artifacts linked to one Operator Session.
 * Legacy records are invisible to listRuns and are deliberately left untouched.
 */
export async function deleteSessionRuns(rootPath: string, sessionId: string): Promise<string[]> {
  const owner = sessionId.trim();
  if (!owner) {
    throw new Error("sessionId is required");
  }
  const root = path.resolve(rootPath);
  const dir = runsDir(root);
  const records = (await listRuns(root)).filter((record) => record.sessionId === owner);
  const deleted: string[] = [];

  for (const record of records) {
    const runId = record.runId;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId.includes("..")) {
      throw new Error(`refusing to delete invalid runId: ${runId}`);
    }
    const artifactPath = path.join(dir, runId);
    const recordPath = runRecordPath(root, runId);
    if (!isPathInside(dir, artifactPath) || !isPathInside(dir, recordPath)) {
      throw new Error(`refusing to delete run outside runs directory: ${runId}`);
    }

    try {
      const info = await lstat(artifactPath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        await unlink(artifactPath);
      } else {
        await makeTreeWritable(artifactPath);
        await rm(artifactPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }

    try {
      await unlink(recordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
    deleted.push(runId);
  }

  deleted.sort((a, b) => a.localeCompare(b));
  return deleted;
}
