import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { claimText, exists, removePath, syncDirectory, withExclusiveLock, writeText } from "./files.js";
import { parseDelegateState } from "./lead/delegates.js";
import type {
  WikiActivityEntry,
  WikiAgentSnapshot,
  WikiAgentTarget,
  WikiAgentTelemetry,
  WikiContextStats,
  WikiDelegationBatchSummary,
  WikiExecutionBudgets,
  WikiRunPause,
  WikiRunProgress,
  WikiRunStage,
  WikiRunStatus,
  WikiRunView,
  WikiRunWarning,
} from "./producer-types.js";
import type {
  WikiAgentRecord,
  WikiProductionPlan,
  WikiTaskRuntimeState,
  WikiTaskRuntimeTaskState,
} from "./runtime-types.js";

export const WIKI_RUN_FORMAT = 3 as const;

export class UnsupportedWikiRunVersionError extends Error {
  constructor(readonly location: string, readonly found: unknown, readonly expected: number) {
    super(`Unsupported Wiki format at ${location}: expected ${expected}, found ${String(found)}. Preserve needed evidence, then delete stale .okf-wiki Run state. The Published Wiki is independent.`);
    this.name = "UnsupportedWikiRunVersionError";
  }
}

export interface WikiExecutionAuthority {
  attempt: number;
  executionToken: string;
}

export interface WikiExecutionOwner {
  pid: number;
}

export type WikiProductionTransition =
  | { kind: "started"; at: string }
  | { kind: "attempt_started"; at: string; executionToken: string; owner: WikiExecutionOwner }
  | { kind: "plan_pinned"; at: string; plan: WikiProductionPlan }
  | { kind: "stage_entered"; at: string; stage: WikiRunStage; budgets?: WikiExecutionBudgets }
  | { kind: "lead_completed"; at: string; summary: string }
  | { kind: "paused"; at: string; pause: WikiRunPause }
  | { kind: "interrupted" | "manual_paused"; at: string }
  | { kind: "resumed"; at: string; executionToken: string; owner: WikiExecutionOwner }
  | { kind: "cancelled"; at: string }
  | { kind: "failed"; at: string; error: string }
  | { kind: "warning"; at: string; warning: WikiRunWarning }
  | { kind: "published"; at: string; pages: string[]; sourceFingerprint: string; finalTreeDigest: string };

export interface WikiLeadFacts {
  candidateRevision: number;
  specRevision: number;
  policyDigest: string;
  compactionObserved: boolean;
  sourceScopeIds: readonly string[];
  spec?: unknown;
  taxonomy?: unknown;
  reviews: readonly unknown[];
  delegates: WikiTaskRuntimeState;
}

export interface WikiRunFacts {
  version: typeof WIKI_RUN_FORMAT;
  id: string;
  cwd: string;
  focus?: string;
  status: WikiRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  pause?: WikiRunPause;
  warnings?: WikiRunWarning[];
  attempt: number;
  executionToken?: string;
  pid?: number;
  leadSummary?: string;
  publication?: { pages: string[]; sourceFingerprint: string; finalTreeDigest: string };
  stage?: WikiRunStage;
  language?: "zh" | "en";
  budgets?: WikiExecutionBudgets;
  productionPlan?: WikiProductionPlan;
  lead: WikiLeadFacts;
}

export type WikiLiveSample =
  | { kind: "telemetry"; target: WikiAgentTarget; telemetry: WikiAgentTelemetry }
  | { kind: "health"; target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string };

export type WikiRunRecordFaultPoint = "beforeCommitLead" | "afterCommitLead";

export interface WikiRunRecordOptions {
  fault?: (point: WikiRunRecordFaultPoint) => void | Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set<WikiRunStatus>(["succeeded", "failed", "cancelled"]);
const EMPTY_DIGEST = "0".repeat(64);

export function emptyWikiLeadFacts(sourceScopeIds: readonly string[] = []): WikiLeadFacts {
  return {
    candidateRevision: 0,
    specRevision: 0,
    policyDigest: EMPTY_DIGEST,
    compactionObserved: false,
    sourceScopeIds: [...sourceScopeIds],
    reviews: [],
    delegates: { batches: [] },
  };
}

export function createWikiRunRecord(rootDirectory: string, options: WikiRunRecordOptions = {}) {
  const root = path.resolve(rootDirectory);
  const runsRoot = path.join(root, "runs");
  const activeFile = path.join(root, "active-run");
  const lockPath = path.join(root, ".ledger.lock");
  const cache = new Map<string, WikiRunFacts>();

  const writeExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    await mkdir(root, { recursive: true });
    return await withExclusiveLock(lockPath, operation);
  };

  const paths = (runId: string) => {
    assertSafeId(runId, "Wiki run ID");
    const directory = path.join(runsRoot, runId);
    return {
      directory,
      state: path.join(directory, "run.json"),
      plan: path.join(directory, "plan.json"),
      staleLead: path.join(directory, "lead-state.json"),
      staleState: path.join(directory, "run-state.json"),
      staleEvents: path.join(directory, "events"),
      staleJournal: path.join(directory, "pending-transaction.json"),
      agent: (target: WikiAgentTarget) => target.kind === "lead"
        ? path.join(directory, "agents", "lead.json")
        : path.join(directory, "agents", "tasks", String(target.batch), `${safeTaskId(target.taskId)}.json`),
      legacyTask: (taskId: string) => path.join(directory, "agents", "tasks", `${safeTaskId(taskId)}.json`),
    };
  };

  const remember = (facts: WikiRunFacts): WikiRunFacts => {
    cache.set(facts.id, facts);
    return facts;
  };

  const assertCurrentLayout = async (runId: string): Promise<void> => {
    const runPaths = paths(runId);
    if (await exists(runPaths.staleLead) || await exists(runPaths.staleState)
      || await exists(runPaths.staleEvents) || await exists(runPaths.staleJournal)) {
      throw new UnsupportedWikiRunVersionError(`runs/${runId}`, "legacy process files", WIKI_RUN_FORMAT);
    }
  };

  const readFacts = async (runId: string): Promise<WikiRunFacts | undefined> => {
    await assertCurrentLayout(runId);
    const file = paths(runId).state;
    try {
      const facts = parseFacts(JSON.parse(await readFile(file, "utf8")), runId);
      const plan = await readPinnedPlan(runId);
      if (plan) facts.productionPlan = plan;
      return remember(facts);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const ensure = async (runId: string): Promise<WikiRunFacts | undefined> => cache.get(runId) ?? await readFacts(runId);

  const writeFacts = async (facts: WikiRunFacts): Promise<void> => {
    const target = paths(facts.id).state;
    await ensureDirectoryDurable(path.dirname(target));
    await writeText(target, `${JSON.stringify(durableFacts(facts), null, 2)}\n`);
    remember(facts);
  };

  const writeTail = async (runId: string, target: WikiAgentTarget, record: WikiAgentRecord): Promise<void> => {
    const targetPath = paths(runId).agent(target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeText(targetPath, `${JSON.stringify({
      agent: record.agent,
      process: record.process,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
    }, null, 2)}\n`, { sync: "file" });
  };

  const writePinnedPlanOnce = async (runId: string, plan: WikiProductionPlan): Promise<void> => {
    const target = paths(runId).plan;
    if (await exists(target)) return;
    await ensureDirectoryDurable(path.dirname(target));
    await writeText(target, `${JSON.stringify(plan, null, 2)}\n`);
  };

  const readPinnedPlan = async (runId: string): Promise<WikiProductionPlan | undefined> => {
    try {
      return parseProductionPlan(JSON.parse(await readFile(paths(runId).plan, "utf8")), runId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const readTailFile = async (file: string): Promise<WikiAgentRecord | undefined> => {
    try {
      return parseTail(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const readAgentTail = async (runId: string, target: WikiAgentTarget): Promise<WikiAgentRecord | undefined> => {
    const runPaths = paths(runId);
    const current = await readTailFile(runPaths.agent(target));
    if (current || target.kind === "lead") return current;
    return await readTailFile(runPaths.legacyTask(target.taskId));
  };

  return {
    async create(input: { id: string; cwd: string; focus?: string; at: string }): Promise<WikiRunFacts> {
      return await writeExclusive(async () => {
        assertSafeId(input.id, "Wiki run ID");
        await ensureDirectoryDurable(root);
        if (await readFacts(input.id)) throw new Error(`Wiki run ${input.id} already exists`);
        const existing = await activeRunId(activeFile);
        if (existing) {
          const active = await readFacts(existing);
          if (active && !TERMINAL.has(active.status)) {
            throw new Error(`Wiki run ${existing} is already active in this workspace`);
          }
          await removePath(activeFile, { force: true });
        }
        await claimText(activeFile, `${JSON.stringify({ version: WIKI_RUN_FORMAT, runId: input.id })}\n`);
        const facts: WikiRunFacts = {
          version: WIKI_RUN_FORMAT,
          id: input.id,
          cwd: path.resolve(input.cwd),
          ...(input.focus ? { focus: input.focus } : {}),
          status: "running",
          createdAt: input.at,
          updatedAt: input.at,
          attempt: 0,
          lead: emptyWikiLeadFacts(),
        };
        try {
          await writeFacts(facts);
          return facts;
        } catch (error) {
          await removePath(activeFile, { force: true });
          throw error;
        }
      });
    },

    async read(runId: string): Promise<WikiRunFacts | undefined> {
      return await readFacts(runId);
    },

    async list(): Promise<WikiRunFacts[]> {
      let entries: string[];
      try {
        entries = await readdir(runsRoot);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const states = await Promise.all(entries.filter((entry) => SAFE_ID.test(entry)).map((entry) => readFacts(entry)));
      return states.filter((facts): facts is WikiRunFacts => facts !== undefined)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },

    async drive(runId: string, transition: WikiProductionTransition, authority?: WikiExecutionAuthority): Promise<WikiRunFacts> {
      return await writeExclusive(async () => {
        const current = await ensure(runId);
        if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
        if (TERMINAL.has(current.status)) throw new Error(`Terminal Wiki run ${runId} is immutable`);
        if (authority && (current.attempt !== authority.attempt || current.executionToken !== authority.executionToken || current.status !== "running")) {
          throw new Error("Wiki execution authority is no longer current");
        }
        const commit = async (at: string, mutate: (facts: WikiRunFacts) => WikiRunFacts, releaseActive = false) => {
          const next = mutate(cloneFacts(current));
          next.updatedAt = at;
          assertFactsLifecycle(next, runId);
          await writeFacts(next);
          if (releaseActive && await activeRunId(activeFile) === next.id) await removePath(activeFile, { force: true });
          return next;
        };
        switch (transition.kind) {
          case "started":
            if (current.attempt !== 0) throw new Error("Wiki run may be started only once");
            return await commit(transition.at, (facts) => facts);
          case "attempt_started":
            if (current.status !== "running" || current.attempt !== 0 || current.executionToken) {
              throw new Error("The initial Wiki attempt may start only once");
            }
            return await commit(transition.at, (facts) => ({
              ...facts, attempt: 1, executionToken: transition.executionToken, pid: transition.owner.pid, stage: "prepare",
            }));
          case "paused":
            if (current.status !== "running") throw new Error("Only a running Wiki run may pause");
            return await commit(transition.at, (facts) => {
              const next = { ...facts, status: "paused" as const, pause: transition.pause };
              delete next.executionToken;
              delete next.pid;
              return next;
            });
          case "interrupted":
          case "manual_paused":
            if (current.status !== "running") throw new Error("Only a running Wiki run may pause");
            return await commit(transition.at, (facts) => {
              const next = { ...facts, status: "paused" as const, pause: undefined };
              delete next.executionToken;
              delete next.pid;
              return next;
            });
          case "resumed":
            if (current.status !== "paused") throw new Error("Only a paused Wiki run may resume");
            return await commit(transition.at, (facts) => ({
              ...facts, status: "running", attempt: facts.attempt + 1,
              executionToken: transition.executionToken, pid: transition.owner.pid, error: undefined, pause: undefined,
            }));
          case "cancelled":
            if (current.status !== "running" && current.status !== "paused") throw new Error("Only an active Wiki run may be cancelled");
            return await commit(transition.at, (facts) => {
              const next = { ...facts, status: "cancelled" as const, completedAt: transition.at };
              delete next.executionToken;
              delete next.pid;
              return next;
            }, true);
          case "failed":
            if (current.status !== "running") throw new Error("Only a running Wiki run may fail");
            return await commit(transition.at, (facts) => {
              const next = { ...facts, status: "failed" as const, error: transition.error, completedAt: transition.at };
              delete next.executionToken;
              delete next.pid;
              return next;
            }, true);
          case "warning":
            return await commit(transition.at, (facts) => ({
              ...facts, warnings: [...(facts.warnings ?? []), transition.warning],
            }));
          case "stage_entered":
            if (current.status !== "running" || !current.productionPlan) {
              throw new Error("Wiki stage requires a pinned running production plan");
            }
            return await commit(transition.at, (facts) => ({
              ...facts, stage: transition.stage, ...(transition.budgets ? { budgets: transition.budgets } : {}),
            }));
          case "lead_completed":
            return await commit(transition.at, (facts) => ({ ...facts, leadSummary: transition.summary }));
          case "published":
            if (current.leadSummary === undefined) throw new Error("Wiki publication requires a completed Lead on a running run");
            return await commit(transition.at, (facts) => {
              const next = {
                ...facts, status: "succeeded" as const,
                publication: { pages: transition.pages, sourceFingerprint: transition.sourceFingerprint, finalTreeDigest: transition.finalTreeDigest },
                completedAt: transition.at,
              };
              delete next.executionToken;
              delete next.pid;
              return next;
            }, true);
          case "plan_pinned": {
            if (current.productionPlan || await exists(paths(runId).plan)) {
              throw new Error("Wiki production plan is already pinned");
            }
            const plan = parseProductionPlan(transition.plan, runId);
            await writePinnedPlanOnce(runId, plan);
            return await commit(transition.at, (facts) => ({
              ...facts, language: plan.language, productionPlan: plan,
            }));
          }
          default:
            throw new Error("Unknown Wiki run drive");
        }
      });
    },

    async commitLead(runId: string, next: WikiLeadFacts, authority: WikiExecutionAuthority): Promise<WikiRunFacts> {
      return await writeExclusive(async () => {
        const current = await ensure(runId);
        if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
        if (current.status !== "running" || current.attempt !== authority.attempt || current.executionToken !== authority.executionToken) {
          throw new Error("Wiki execution authority is no longer current");
        }
        await options.fault?.("beforeCommitLead");
        const lead = parseLeadFacts(next);
        const facts = { ...cloneFacts(current), lead, updatedAt: current.updatedAt };
        assertFactsLifecycle(facts, runId);
        await writeFacts(facts);
        await options.fault?.("afterCommitLead");
        return facts;
      });
    },

    async noteLive(runId: string, sample: WikiLiveSample, authority: WikiExecutionAuthority): Promise<void> {
      const current = await ensure(runId);
      if (!current || current.status !== "running" || current.attempt !== authority.attempt
        || current.executionToken !== authority.executionToken) return;
      const target = sample.target;
      const existing = await readAgentTail(runId, target);
      const telemetry = sample.kind === "telemetry" ? sample.telemetry : undefined;
      const at = sample.kind === "telemetry" ? sample.telemetry.sampledAt : sample.at;
      const sessionFile = telemetry?.sessionFile ?? existing?.sessionFile;
      const agent: WikiAgentSnapshot = {
        ...(existing?.agent ?? {
          target,
          role: target.kind === "lead" ? "lead" : "write",
          status: "running",
          attempt: authority.attempt,
          activity: "waiting_model",
          activeTools: [],
          health: "healthy",
          updatedAt: at,
        }),
        ...(telemetry?.activity ? { activity: telemetry.activity } : {}),
        ...(telemetry?.activeTools ? { activeTools: telemetry.activeTools } : {}),
        ...(telemetry?.usage ? { usage: telemetry.usage } : {}),
        ...(telemetry?.lastHeartbeatAt ? { lastHeartbeatAt: telemetry.lastHeartbeatAt } : {}),
        ...(telemetry?.lastActivityAt ? { lastActivityAt: telemetry.lastActivityAt } : {}),
        ...(sample.kind === "health" ? { health: sample.status } : {}),
        attempt: telemetry?.attempt ?? existing?.agent.attempt ?? authority.attempt,
        updatedAt: at,
      };
      await writeTail(runId, target, {
        agent,
        process: limitProcess(telemetry?.process ?? existing?.process ?? []),
        ...(sessionFile ? { sessionFile } : {}),
      });
    },

    async readTail(runId: string, target: WikiAgentTarget): Promise<WikiAgentRecord | undefined> {
      if (!(await ensure(runId))) throw new Error(`Unknown Wiki run: ${runId}`);
      return await readAgentTail(runId, target);
    },

    async assertActive(runId: string, authority: WikiExecutionAuthority): Promise<void> {
      const facts = await readFacts(runId);
      if (!facts || facts.status !== "running" || facts.attempt !== authority.attempt || facts.executionToken !== authority.executionToken) {
        throw new Error(`Wiki Lead execution ${authority.attempt}/${authority.executionToken} is no longer active`);
      }
    },

    async executionOwner(runId: string): Promise<"live" | "stale" | "absent"> {
      const facts = await readFacts(runId);
      if (!facts) throw new Error(`Unknown Wiki run: ${runId}`);
      if (facts.status !== "running" || !facts.pid) return "absent";
      return processIsAlive(facts.pid) ? "live" : "stale";
    },
  };
}

export type WikiRunRecord = ReturnType<typeof createWikiRunRecord>;

export function projectRunView(facts: WikiRunFacts, tails: readonly WikiAgentRecord[] = []): WikiRunView {
  const batches = facts.lead.delegates.batches.map((batch) => projectBatch(batch, facts.updatedAt, tails));
  const currentBatch = batches.at(-1);
  const leadRecord = tails.find((tail) => tail.agent.target.kind === "lead");
  const leadTail = leadRecord?.process.length
    ? { ...leadRecord.agent, process: leadRecord.process }
    : leadRecord?.agent;
  const recentActivity = projectRecentActivity(tails);
  const usage = projectUsageFromTails(tails);
  const progress: WikiRunProgress = {
    stage: facts.stage ?? "prepare",
    ...(facts.language ? { language: facts.language } : {}),
    ...(facts.budgets ? { budgets: facts.budgets } : {}),
    ...(leadTail ? { lead: leadTail } : {}),
    ...(currentBatch ? { currentBatch, batches } : {}),
    ...(recentActivity.length ? { recentActivity } : {}),
    ...(usage ? { usage } : {}),
  };
  return {
    id: facts.id,
    cwd: facts.cwd,
    ...(facts.focus ? { focus: facts.focus } : {}),
    status: facts.status,
    createdAt: facts.createdAt,
    updatedAt: facts.updatedAt,
    ...(facts.completedAt ? { completedAt: facts.completedAt } : {}),
    ...(facts.error ? { error: facts.error } : {}),
    ...(facts.pause ? { pause: facts.pause } : {}),
    ...(facts.warnings?.length ? { warnings: facts.warnings } : {}),
    progress,
  };
}

function projectBatch(
  batch: WikiTaskRuntimeState["batches"][number],
  at: string,
  tails: readonly WikiAgentRecord[],
): WikiDelegationBatchSummary {
  const tasks = batch.tasks.map((task) => projectTask(task, batch.batchId, tails));
  const complete = tasks.filter((task) => task.status === "complete").length;
  const terminal = tasks.filter((task) => ["complete", "incomplete", "failed"].includes(task.status)).length;
  const status = tasks.length > 0 && terminal === tasks.length
    ? complete === tasks.length ? "complete" : complete > 0 ? "partial" : "failed"
    : "running";
  return { batch: batch.batchId, status, completed: complete, total: tasks.length, tasks, startedAt: at };
}

const AGGREGATE_USAGE_FIELDS = ["turns", "toolCalls", "input", "output", "cacheRead", "cacheWrite", "total", "cost"] as const;

function projectRecentActivity(tails: readonly WikiAgentRecord[]): WikiActivityEntry[] {
  return tails.flatMap((tail) => tail.process)
    .sort((left, right) => left.at.localeCompare(right.at) || left.sequence - right.sequence)
    .slice(-20);
}

function projectUsageFromTails(tails: readonly WikiAgentRecord[]): WikiContextStats | undefined {
  const totals: WikiContextStats = {};
  let any = false;
  for (const tail of tails) {
    const usage = tail.agent.usage;
    if (!usage) continue;
    any = true;
    for (const field of AGGREGATE_USAGE_FIELDS) {
      const value = usage[field];
      if (value !== undefined) totals[field] = (totals[field] ?? 0) + value;
    }
  }
  return any ? totals : undefined;
}

function projectTask(
  task: WikiTaskRuntimeTaskState,
  batch: number,
  tails: readonly WikiAgentRecord[],
): WikiAgentSnapshot {
  const record = tails.find((entry) => entry.agent.target.kind === "task"
    && entry.agent.target.batch === batch && entry.agent.target.taskId === task.task.id);
  const tail = record?.agent;
  const status = task.phase === "queued" ? "queued"
    : task.phase === "running" || task.phase === "paused" ? "running"
      : task.receipt!.status;
  const activity = tail?.activity
    ?? (status === "queued" ? "starting" : status === "running" ? "waiting_model" : "settled");
  return {
    target: { kind: "task", batch, taskId: task.task.id },
    role: task.task.role,
    status,
    attempt: task.attempt,
    activity,
    activeTools: tail?.activeTools ?? [],
    health: tail?.health ?? "healthy",
    ...(task.receipt?.summary ? { summary: task.receipt.summary } : {}),
    ...(tail?.startedAt ? { startedAt: tail.startedAt } : {}),
    ...(tail?.updatedAt ? { updatedAt: tail.updatedAt } : {}),
    ...(tail?.lastActivityAt ? { lastActivityAt: tail.lastActivityAt } : {}),
    ...(tail?.lastHeartbeatAt ? { lastHeartbeatAt: tail.lastHeartbeatAt } : {}),
    ...(tail?.deadlineAt ? { deadlineAt: tail.deadlineAt } : {}),
    ...(tail?.usage ? { usage: tail.usage } : {}),
    ...(record?.process.length ? { process: record.process } : {}),
  };
}

function parseFacts(value: unknown, expectedId: string): WikiRunFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki run state: ${expectedId}`);
  const raw = value as Record<string, unknown>;
  if (raw.version !== WIKI_RUN_FORMAT) {
    throw new UnsupportedWikiRunVersionError(`runs/${expectedId}/run.json`, raw.version, WIKI_RUN_FORMAT);
  }
  if (raw.id !== expectedId || typeof raw.cwd !== "string"
    || !["running", "paused", "succeeded", "failed", "cancelled"].includes(String(raw.status))
    || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string"
    || !Number.isInteger(raw.attempt) || (raw.attempt as number) < 0
    || (raw.executionToken !== undefined && !isToken(raw.executionToken))
    || (raw.pid !== undefined && (!Number.isSafeInteger(raw.pid) || (raw.pid as number) < 1))
    || (raw.leadSummary !== undefined && typeof raw.leadSummary !== "string")
    || (raw.focus !== undefined && typeof raw.focus !== "string")
    || (raw.completedAt !== undefined && typeof raw.completedAt !== "string")
    || (raw.error !== undefined && typeof raw.error !== "string")
    || (raw.stage !== undefined && !["prepare", "lead", "validate", "publish"].includes(String(raw.stage)))
    || (raw.language !== undefined && raw.language !== "zh" && raw.language !== "en")
    || !isPause(raw.pause)) {
    throw new Error(`Invalid Wiki run state: ${expectedId}`);
  }
  const facts: WikiRunFacts = {
    version: WIKI_RUN_FORMAT,
    id: raw.id as string,
    cwd: raw.cwd as string,
    ...(typeof raw.focus === "string" ? { focus: raw.focus } : {}),
    status: raw.status as WikiRunStatus,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    ...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(raw.pause ? { pause: raw.pause as WikiRunPause } : {}),
    attempt: raw.attempt as number,
    ...(typeof raw.executionToken === "string" ? { executionToken: raw.executionToken } : {}),
    ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
    ...(typeof raw.leadSummary === "string" ? { leadSummary: raw.leadSummary } : {}),
    ...(raw.publication && typeof raw.publication === "object" ? { publication: raw.publication as NonNullable<WikiRunFacts["publication"]> } : {}),
    ...(Array.isArray(raw.warnings) && raw.warnings.length ? { warnings: raw.warnings as WikiRunWarning[] } : {}),
    ...(raw.stage ? { stage: raw.stage as WikiRunStage } : {}),
    ...(raw.language === "zh" || raw.language === "en" ? { language: raw.language } : {}),
    ...(raw.budgets && typeof raw.budgets === "object" ? { budgets: raw.budgets as WikiExecutionBudgets } : {}),
    lead: parseLeadFacts(raw.lead ?? emptyWikiLeadFacts()),
  };
  assertFactsLifecycle(facts, expectedId);
  return facts;
}

function parseLeadFacts(value: unknown): WikiLeadFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki Lead facts");
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.candidateRevision) || (raw.candidateRevision as number) < 0
    || !Number.isSafeInteger(raw.specRevision) || (raw.specRevision as number) < 0
    || typeof raw.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.policyDigest)
    || typeof raw.compactionObserved !== "boolean"
    || !Array.isArray(raw.sourceScopeIds) || raw.sourceScopeIds.some((item) => typeof item !== "string")
    || !Array.isArray(raw.reviews)) {
    throw new Error("Invalid Wiki Lead facts");
  }
  return {
    candidateRevision: raw.candidateRevision as number,
    specRevision: raw.specRevision as number,
    policyDigest: raw.policyDigest,
    compactionObserved: raw.compactionObserved,
    sourceScopeIds: [...raw.sourceScopeIds as string[]],
    ...(raw.spec !== undefined ? { spec: raw.spec } : {}),
    ...(raw.taxonomy !== undefined ? { taxonomy: raw.taxonomy } : {}),
    reviews: [...raw.reviews],
    delegates: parseDelegateState(raw.delegates),
  };
}

function parseTail(value: unknown): WikiAgentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki agent record");
  const raw = value as Record<string, unknown>;
  const agent = raw.agent as WikiAgentSnapshot | undefined;
  if (!agent || typeof agent !== "object" || !Array.isArray(raw.process)) throw new Error("Invalid Wiki agent record");
  return {
    agent,
    process: limitProcess(raw.process as WikiActivityEntry[]),
    ...(typeof raw.sessionFile === "string" && raw.sessionFile ? { sessionFile: raw.sessionFile } : {}),
  };
}

function durableFacts(facts: WikiRunFacts): Record<string, unknown> {
  const { productionPlan: _plan, ...rest } = facts;
  return rest;
}

function cloneFacts(facts: WikiRunFacts): WikiRunFacts {
  return structuredClone(facts);
}

function assertFactsLifecycle(facts: WikiRunFacts, expectedId: string): void {
  if (facts.id !== expectedId) throw new Error(`Invalid Wiki run state: ${expectedId}`);
  if (facts.status === "running" && facts.attempt > 0 && !facts.executionToken
    || facts.status !== "running" && facts.executionToken
    || TERMINAL.has(facts.status) !== Boolean(facts.completedAt)
    || facts.status === "succeeded" && (!facts.publication || facts.leadSummary === undefined)
    || facts.status === "failed" && !facts.error) throw new Error(`Invalid Wiki run state lifecycle: ${expectedId}`);
}

function isPause(value: unknown): value is WikiRunPause | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const pause = value as Partial<WikiRunPause>;
  return (pause.reason === "quota" || pause.reason === "usage_limit")
    && typeof pause.summary === "string"
    && (pause.retryAt === undefined || typeof pause.retryAt === "string");
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
}

function safeTaskId(value: string): string {
  assertSafeId(value, "Wiki task ID");
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function activeRunId(file: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { version?: unknown; runId?: unknown };
    if (value.version !== WIKI_RUN_FORMAT || typeof value.runId !== "string") {
      throw new UnsupportedWikiRunVersionError(file, value.version, WIKI_RUN_FORMAT);
    }
    assertSafeId(value.runId, "Wiki run ID");
    return value.runId;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function ensureDirectoryDurable(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await syncDirectory(directory);
  const parent = path.dirname(directory);
  if (parent !== directory) await syncDirectory(parent);
}

function limitProcess(entries: WikiActivityEntry[]): WikiActivityEntry[] {
  return entries.slice(-200);
}

export function parseProductionPlan(value: unknown, runId: string): WikiProductionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki production plan: ${runId}`);
  const plan = value as Partial<WikiProductionPlan> & Record<string, unknown>;
  assertExactKeys(plan, ["sourcePlan", "candidateWikiRoot", "skillRoot", "skillTreeDigest", "language", "generation",
    "maxConcurrentAgents", "budgets", "models", "runSessionDirectory", "leadSessionFile", "leadSessionAttempt", "transientRetries",
    "sessionTimeoutMs", "baseRetryDelayMs", "prompt"], "Wiki production plan");
  const sourcePlan = parsePinnedSourcePlan(plan.sourcePlan, runId);
  if (!sourcePlan || typeof plan.candidateWikiRoot !== "string" || typeof plan.skillRoot !== "string" || !isDigest(plan.skillTreeDigest)
    || (plan.language !== "zh" && plan.language !== "en")
    || typeof plan.runSessionDirectory !== "string" || typeof plan.prompt !== "string"
    || !parseExecutionBudgets(plan.budgets) || !isRoleModels(plan.models) || !isGenerationProfile(plan.generation)
    || !Number.isInteger(plan.maxConcurrentAgents) || (plan.maxConcurrentAgents ?? 0) < 1
    || !Number.isInteger(plan.transientRetries) || (plan.transientRetries ?? -1) < 0
    || !Number.isFinite(plan.sessionTimeoutMs) || (plan.sessionTimeoutMs ?? 0) <= 0
    || !Number.isFinite(plan.baseRetryDelayMs) || (plan.baseRetryDelayMs ?? -1) < 0) {
    throw new Error(`Invalid Wiki production plan: ${runId}`);
  }
  const expectedRunRoot = path.join(sourcePlan.workspaceRoot, ".okf-wiki", "runs", runId);
  if (path.resolve(sourcePlan.workspaceRoot) !== sourcePlan.workspaceRoot
    || path.resolve(plan.candidateWikiRoot) !== path.join(expectedRunRoot, "candidate", "wiki")
    || path.resolve(plan.skillRoot) !== path.join(expectedRunRoot, "skill")
    || path.resolve(plan.runSessionDirectory) !== path.join(expectedRunRoot, "sessions")) {
    throw new Error(`Invalid Wiki production plan identity: ${runId}`);
  }
  return Object.freeze(structuredClone(plan as WikiProductionPlan));
}

function parsePinnedSourcePlan(value: unknown, runId: string): WikiProductionPlan["sourcePlan"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<WikiProductionPlan["sourcePlan"]> & Record<string, unknown>;
  assertExactKeys(raw, ["workspaceRoot", "workspaceRealPath", "configPath", "defaultSourceIgnores", "excludes", "sources", "fingerprint"], "Wiki pinned source plan");
  if (typeof raw.workspaceRoot !== "string" || typeof raw.workspaceRealPath !== "string" || typeof raw.configPath !== "string"
    || typeof raw.defaultSourceIgnores !== "boolean" || !isStringArray(raw.excludes) || !Array.isArray(raw.sources)
    || typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) return undefined;
  const scopes = new Set<string>();
  const sources = raw.sources.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki pinned source: ${runId}`);
    const source = value as Partial<WikiProductionPlan["sourcePlan"]["sources"][number]>;
    assertExactKeys(source as Record<string, unknown>, ["scopeId", "logicalPath", "absolutePath", "realPath", "repositoryRoot", "repositoryIdentity", "origin", "head", "dirtyFingerprint"], "Wiki pinned source");
    if (typeof source.scopeId !== "string" || !source.scopeId || scopes.has(source.scopeId)
      || typeof source.logicalPath !== "string" || typeof source.absolutePath !== "string" || typeof source.realPath !== "string"
      || typeof source.repositoryRoot !== "string" || typeof source.repositoryIdentity !== "string"
      || !isPinnedOrigin(source.origin)
      || typeof source.head !== "string" || typeof source.dirtyFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(source.repositoryIdentity) || !/^[a-f0-9]{64}$/.test(source.dirtyFingerprint)) {
      throw new Error(`Invalid Wiki pinned source: ${runId}`);
    }
    if (path.resolve(source.absolutePath) !== source.absolutePath || path.resolve(source.realPath) !== source.realPath
      || path.resolve(source.repositoryRoot) !== source.repositoryRoot) throw new Error(`Invalid Wiki pinned source paths: ${runId}`);
    scopes.add(source.scopeId);
    return structuredClone(source as WikiProductionPlan["sourcePlan"]["sources"][number]);
  });
  if (path.resolve(raw.workspaceRoot) !== raw.workspaceRoot || path.resolve(raw.workspaceRealPath) !== raw.workspaceRealPath
    || path.resolve(raw.configPath) !== raw.configPath) throw new Error(`Invalid Wiki pinned workspace paths: ${runId}`);
  return { ...structuredClone(raw as WikiProductionPlan["sourcePlan"]), sources };
}

function isPinnedOrigin(value: unknown): value is WikiProductionPlan["sourcePlan"]["sources"][number]["origin"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.type === "link") return Object.keys(raw).every((key) => ["type", "localPath"].includes(key)) && typeof raw.localPath === "string";
  return raw.type === "clone" && Object.keys(raw).every((key) => ["type", "remoteUrl", "ref"].includes(key))
    && typeof raw.remoteUrl === "string" && (raw.ref === undefined || typeof raw.ref === "string");
}

function parseExecutionBudgets(value: unknown): WikiExecutionBudgets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<WikiExecutionBudgets> & Record<string, unknown>;
  const fields = ["maxDelegatedTasks", "maxDelegateBatches", "maxTurnsPerSession", "maxToolCallsPerSession"] as const;
  if (Object.keys(raw).some((key) => !fields.includes(key as typeof fields[number]))) return undefined;
  if (fields.some((field) => !Number.isInteger(raw[field]) || (raw[field] ?? 0) < 1)) return undefined;
  return raw as WikiExecutionBudgets;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRoleModels(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const roles = new Set(["lead", "research", "write", "review"]);
  const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return Object.entries(value).every(([role, selected]) => {
    if (!roles.has(role) || !selected || typeof selected !== "object" || Array.isArray(selected)) return false;
    const raw = selected as Record<string, unknown>;
    return Object.keys(raw).every((key) => ["provider", "id", "thinkingLevel"].includes(key))
      && typeof raw.provider === "string" && raw.provider.length > 0 && typeof raw.id === "string" && raw.id.length > 0
      && (raw.thinkingLevel === undefined || thinking.has(String(raw.thinkingLevel)));
  });
}

function isGenerationProfile(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (!hasExactKeys(raw, ["audience", "purpose", "focus", "granularity", "templates", "review"])
    || !isStringArray(raw.audience) || typeof raw.purpose !== "string") return false;
  return stringArrayRecord(raw.focus, ["include", "exclude"])
    && stringArrayRecord(raw.granularity, ["preferChildPagesFor"])
    && stringArrayRecord(raw.templates, ["requiredSections"])
    && stringArrayRecord(raw.review, ["mustCover"]);
}

function stringArrayRecord(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return hasExactKeys(raw, fields) && fields.every((field) => isStringArray(raw[field]));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}
