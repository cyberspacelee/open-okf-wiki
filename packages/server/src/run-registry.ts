import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  StoredRunRecordSchema,
  type StoredRunRecord,
  type WikiRunRecordStatus,
} from "@okf-wiki/contract";
import { WORKSPACE_DIR_NAME, isPathInside } from "@okf-wiki/core";

const RUNS_DIR_NAME = "runs";

/** Absolute path to `{root}/.okf-wiki/runs`. */
function runsDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME, RUNS_DIR_NAME);
}

/** Absolute path to `{root}/.okf-wiki/runs/{runId}.json`. */
function runRecordPath(rootPath: string, runId: string): string {
  return path.join(runsDir(rootPath), `${runId}.json`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, filePath);
}

export type CreateRunOptions = {
  autoApprove?: boolean;
  skillPath?: string;
  skillDigest?: string;
};

/**
 * Create a run record with status `running` and persist it.
 * The server starts agent work after returning this record.
 */
export async function createRun(
  rootPath: string,
  workspaceId: string,
  options?: CreateRunOptions,
): Promise<StoredRunRecord> {
  const resolvedRoot = path.resolve(rootPath);
  const dir = runsDir(resolvedRoot);
  if (!isPathInside(resolvedRoot, dir)) {
    throw new Error("refusing to write runs outside workspace meta directory");
  }

  const now = new Date().toISOString();
  const runId = randomUUID();
  const record: StoredRunRecord = {
    runId,
    workspaceId,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  if (typeof options?.autoApprove === "boolean") {
    record.autoApprove = options.autoApprove;
  }
  if (typeof options?.skillPath === "string" && options.skillPath.trim()) {
    record.skillPath = options.skillPath.trim();
  }
  if (typeof options?.skillDigest === "string" && options.skillDigest.trim()) {
    record.skillDigest = options.skillDigest.trim();
  }

  const parsed = StoredRunRecordSchema.parse(record);
  await atomicWriteJson(runRecordPath(resolvedRoot, runId), parsed);
  return parsed;
}

export type RunRecordPatch = {
  status?: WikiRunRecordStatus;
  error?: string | null;
  pages?: string[] | null;
  summary?: string | null;
  autoApprove?: boolean;
  skillPath?: string | null;
  skillDigest?: string | null;
  plan?: StoredRunRecord["plan"] | null;
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
  const existing = await loadRun(rootPath, runId);
  if (!existing) {
    throw new Error(`run not found: ${runId}`);
  }

  // Cancel wins races against late agent finalization / auto-publish.
  if (
    existing.status === "cancelled" &&
    patch.status !== undefined &&
    patch.status !== "cancelled"
  ) {
    return existing;
  }

  // Cancel while running or waiting on operator (plan HITL); idempotent if already cancelled.
  if (
    patch.status === "cancelled" &&
    existing.status !== "running" &&
    existing.status !== "awaiting_plan" &&
    existing.status !== "cancelled"
  ) {
    throw new RunStatusConflictError(
      existing,
      `run is not running (status: ${existing.status})`,
    );
  }

  const next: StoredRunRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
  };

  if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.autoApprove !== undefined) {
    next.autoApprove = patch.autoApprove;
  }
  if (patch.error === null) {
    delete next.error;
  } else if (typeof patch.error === "string") {
    next.error = patch.error;
  }
  if (patch.pages === null) {
    delete next.pages;
  } else if (Array.isArray(patch.pages)) {
    next.pages = patch.pages;
  }
  if (patch.summary === null) {
    delete next.summary;
  } else if (typeof patch.summary === "string") {
    next.summary = patch.summary;
  }
  if (patch.skillPath === null) {
    delete next.skillPath;
  } else if (typeof patch.skillPath === "string") {
    next.skillPath = patch.skillPath;
  }
  if (patch.skillDigest === null) {
    delete next.skillDigest;
  } else if (typeof patch.skillDigest === "string") {
    next.skillDigest = patch.skillDigest;
  }
  if (patch.plan === null) {
    delete next.plan;
  } else if (patch.plan !== undefined) {
    next.plan = patch.plan;
  }

  // Clear stale error when transitioning to a successful terminal status.
  if (
    patch.status === "awaiting_publication" ||
    patch.status === "awaiting_plan" ||
    patch.status === "published"
  ) {
    delete next.error;
  }

  const parsed = StoredRunRecordSchema.parse(next);
  await atomicWriteJson(runRecordPath(rootPath, runId), parsed);
  return parsed;
}

export async function loadRun(
  rootPath: string,
  runId: string,
): Promise<StoredRunRecord | null> {
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
