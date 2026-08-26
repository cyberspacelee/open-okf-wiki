import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Type, type Static } from "typebox";
import { ensureDirectory, exists, removePath, writeText } from "./files.js";
import { candidateRevision } from "./revisions.js";

const strict = { additionalProperties: false } as const;
const checkSchema = createRequire(import.meta.url)("typebox/schema").Check as (schema: object, value: unknown) => boolean;
const UsageSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  total: Type.Number({ minimum: 0 }),
  cacheRead: Type.Optional(Type.Number({ minimum: 0 })),
  cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
  cost: Type.Optional(Type.Number({ minimum: 0 })),
  compactions: Type.Optional(Type.Number({ minimum: 0 })),
  turns: Type.Optional(Type.Number({ minimum: 0 })),
  toolCalls: Type.Optional(Type.Number({ minimum: 0 })),
  contextTokens: Type.Optional(Type.Number({ minimum: 0 })),
  contextWindow: Type.Optional(Type.Number({ minimum: 0 })),
  contextPercent: Type.Optional(Type.Number({ minimum: 0 })),
}, strict);
const ArtifactSchema = Type.Object({ path: Type.String(), sha256: Type.String() }, strict);
const CatalogSchema = Type.Object({
  url: Type.String(),
  schema: Type.String(),
  tables: Type.Array(Type.String()),
}, strict);
const OriginSchema = Type.Union([
  Type.Object({ type: Type.Literal("link"), localPath: Type.String() }, strict),
  Type.Object({
    type: Type.Literal("clone"),
    remoteUrl: Type.String(),
    ref: Type.Optional(Type.String()),
  }, strict),
]);
const SourceSchema = Type.Object({
  scopeId: Type.String(),
  logicalPath: Type.String(),
  absolutePath: Type.String(),
  realPath: Type.String(),
  repositoryRoot: Type.String(),
  repositoryIdentity: Type.String(),
  origin: OriginSchema,
  catalog: Type.Optional(Type.String()),
  head: Type.String(),
  dirtyFingerprint: Type.String(),
}, strict);
const PlanSchema = Type.Object({
  workspaceRoot: Type.String(),
  workspaceRealPath: Type.String(),
  configPath: Type.String(),
  defaultSourceIgnores: Type.Boolean(),
  excludes: Type.Array(Type.String()),
  catalogs: Type.Record(Type.String(), CatalogSchema),
  sources: Type.Array(SourceSchema),
  fingerprint: Type.String(),
}, strict);
const ExecutionSchema = Type.Object({
  id: Type.String(),
  boardTaskId: Type.String(),
  partition: Type.String(),
  writeMode: Type.Optional(Type.Union([Type.Literal("subtree"), Type.Literal("directory")])),
  agent: Type.String(),
  task: Type.String(),
  taskDigest: Type.String(),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("complete"),
    Type.Literal("failed"),
    Type.Literal("blocked"),
    Type.Literal("interrupted"),
  ]),
  handoff: Type.Optional(ArtifactSchema),
  diagnostic: Type.Optional(ArtifactSchema),
  queuedAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
  terminalReason: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  usage: Type.Optional(UsageSchema),
}, strict);
const ReviewSchema = Type.Object({
  executionId: Type.String(),
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("changes_requested")]),
  candidateRevision: Type.String(),
  sourceFingerprint: Type.String(),
  handoff: ArtifactSchema,
  completedAt: Type.String(),
}, strict);
const CheckSchema = Type.Object({
  candidateRevision: Type.String(),
  ok: Type.Boolean(),
  completedAt: Type.String(),
  issueCount: Type.Integer({ minimum: 0 }),
  issueDigest: Type.String(),
}, strict);
const RunRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
  cwd: Type.String(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  focus: Type.Optional(Type.String()),
  language: Type.Union([Type.Literal("zh"), Type.Literal("en")]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  error: Type.Optional(Type.String()),
  executions: Type.Array(ExecutionSchema),
  review: Type.Optional(ReviewSchema),
  check: Type.Optional(CheckSchema),
  leadAttempts: Type.Array(Type.Object({ completedAt: Type.String(), usage: UsageSchema }, strict)),
  pageCount: Type.Optional(Type.Integer({ minimum: 0 })),
  candidateRoot: Type.String(),
  fingerprint: Type.String(),
  plan: PlanSchema,
  templateFingerprint: Type.Optional(Type.String()),
  finalizedRevision: Type.Optional(Type.String()),
  sessionFile: Type.Optional(Type.String()),
}, strict);

export type RunArtifactRef = Static<typeof ArtifactSchema>;
export type RunExecutionReceipt = Static<typeof ExecutionSchema>;
export type RunRecord = Static<typeof RunRecordSchema>;

export function runDirectory(cwd: string): string {
  return path.join(cwd, ".okf-wiki", "run");
}

export function runTransitionLock(cwd: string): string {
  return path.join(cwd, ".okf-wiki", "run-transition.lock");
}

export async function writeRunRecord(record: RunRecord): Promise<void> {
  await ensureDirectory(runDirectory(record.cwd));
  await writeText(path.join(runDirectory(record.cwd), "run.json"), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readRunRecord(cwd: string): Promise<RunRecord | undefined> {
  try {
    return normalizeRunRecord(JSON.parse(await readFile(path.join(runDirectory(cwd), "run.json"), "utf8")), cwd);
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function cleanupCurrentRun(cwd: string): Promise<void> {
  await removePath(runDirectory(cwd), { recursive: true, force: true });
}

export async function reconcileRecoveredRun(cwd: string): Promise<void> {
  let record: RunRecord | undefined;
  try { record = await readRunRecord(cwd); }
  catch { return; }
  if (!record || (record.status !== "running" && record.status !== "failed")) return;
  if (!record.finalizedRevision || record.review?.verdict !== "pass") return;
  if (record.review.candidateRevision !== record.finalizedRevision || await exists(record.candidateRoot)) return;
  const owner = await readRunOwner(cwd);
  if (owner && processIsAlive(owner.pid)) return;
  const wikiRoot = path.join(cwd, "wiki");
  if (!await exists(wikiRoot)) return;
  try {
    if ((await candidateRevision(wikiRoot)).digest === record.finalizedRevision) await cleanupCurrentRun(cwd);
  } catch {
    // Keep the failed-closed Run when the installed tree cannot be read.
  }
}

export async function claimRunOwner(record: Pick<RunRecord, "cwd" | "id">): Promise<string> {
  const token = randomUUID();
  await writeText(ownerFile(record.cwd), `${JSON.stringify({
    version: 1,
    pid: process.pid,
    token,
    runId: record.id,
  })}\n`);
  return token;
}

export async function assertRunOwnerAvailable(cwd: string, runId: string, token?: string): Promise<void> {
  const owner = await readRunOwner(cwd);
  if (!owner || owner.token === token) return;
  if (processIsAlive(owner.pid)) throw new Error(`Wiki run ${runId} is owned by live process ${owner.pid}`);
  await removePath(ownerFile(cwd), { force: true });
}

export async function runOwnerIsAlive(cwd: string): Promise<boolean> {
  const owner = await readRunOwner(cwd);
  return Boolean(owner && processIsAlive(owner.pid));
}

export async function releaseRunOwner(cwd: string, token?: string): Promise<void> {
  if (!token) return;
  const owner = await readRunOwner(cwd);
  if (owner?.token === token) await removePath(ownerFile(cwd), { force: true });
}

function normalizeRunRecord(value: unknown, cwd: string): RunRecord {
  if (!checkSchema(RunRecordSchema, value)) throw new Error("Run record does not match schema version 1");
  const record = value as RunRecord;
  const root = path.resolve(cwd);
  if (record.cwd !== root) throw new Error("Run record cwd does not match the Workspace");
  if (record.candidateRoot !== path.join(runDirectory(root), "candidate")) throw new Error("Run record Candidate path is invalid");
  if (path.resolve(record.plan.workspaceRoot) !== root || record.plan.fingerprint !== record.fingerprint) {
    throw new Error("Run record plan is invalid");
  }
  if (record.plan.sources.some((source) => source.catalog && !Object.hasOwn(record.plan.catalogs, source.catalog))) {
    throw new Error("Run record Source Catalog is invalid");
  }
  if (![record.createdAt, record.updatedAt, ...record.executions.flatMap((execution) => [
    execution.queuedAt, execution.startedAt, execution.completedAt,
  ]),
    record.review?.completedAt, record.check?.completedAt, ...record.leadAttempts.map((attempt) => attempt.completedAt)]
    .filter((timestamp): timestamp is string => timestamp !== undefined)
    .every((timestamp) => Number.isFinite(Date.parse(timestamp)))) {
    throw new Error("Run record timestamps are invalid");
  }
  if (record.executions.some((execution) => execution.agent === "write"
    ? execution.writeMode === undefined
    : execution.writeMode !== undefined)) {
    throw new Error("Run record execution writeMode is invalid");
  }
  if (record.executions.some((execution) => (
    (execution.status === "queued" && (execution.startedAt !== undefined || execution.completedAt !== undefined))
    || (execution.status === "running" && (execution.startedAt === undefined || execution.completedAt !== undefined))
    || (!["queued", "running"].includes(execution.status) && execution.completedAt === undefined)
  ))) {
    throw new Error("Run record execution lifecycle is invalid");
  }
  if (record.sessionFile) {
    const sessions = path.join(runDirectory(root), "sessions");
    const sessionFile = path.resolve(record.sessionFile);
    if (sessionFile !== sessions && !sessionFile.startsWith(`${sessions}${path.sep}`)) {
      throw new Error("Run record sessionFile is outside the Run");
    }
  }
  return record;
}

async function readRunOwner(cwd: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerFile(cwd), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!Number.isInteger(record.pid) || typeof record.token !== "string") return undefined;
    return { pid: record.pid as number, token: record.token };
  } catch {
    return undefined;
  }
}

function ownerFile(cwd: string): string {
  return path.join(runDirectory(cwd), "owner.json");
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
