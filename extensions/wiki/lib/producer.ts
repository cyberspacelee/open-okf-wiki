import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { inspectWiki, verifyPinnedSourcePlan, type WikiPinnedSourcePlan } from "./inspect.js";
import { exists, renamePath, writeText } from "./files.js";
import { errorMessage } from "./failures.js";
import { loadWikiWorkspace, resolveWorkspaceDatabase, type ResolvedWikiWorkspace, type WikiWorkspaceWikiConfig } from "./workspace.js";
import {
  assertReviewPass,
  formatIssue,
  materializeWikiIndexes,
  stampPublication,
  validateWikiTree,
  type WikiValidation,
} from "./wiki-okf.js";
import { resolveWikiTemplatePack, type WikiTemplatePack } from "./templates.js";
import { writeGuardFromPlan } from "./path-policy.js";
import { candidateTools, createTodoTool } from "./pi/tools.js";
import { runWikiSession, type RunWikiSessionOptions } from "./pi/session.js";
import { createSubagentRuntime, createSubagentTool, type SubagentTaskUpdate } from "./subagent.js";
import { createBoardStore, emptyBoard, replaceBoard, type WikiBoard, type WikiBoardStore } from "./board.js";
import { createPostgresCatalog } from "./postgres.js";
import type { WikiCatalog } from "./catalog.js";
import {
  WikiRunResultError,
  type WikiAgentView,
  type WikiProducer,
  type WikiProducerRequest,
  type WikiProducerResult,
  type WikiRunControl,
  type WikiRunHandle,
  type WikiRunStatus,
  type WikiRunView,
  type WikiSessionActivity,
  type WikiToolView,
  type WikiAgentUsage,
} from "./producer-types.js";
import { candidateRevision, fileRevision, templatePackRevision } from "./revisions.js";
import { formatLeadCheckpoint, type CheckpointExecution, type CheckpointReview } from "./checkpoint.js";

const LEAD_CANDIDATE_TOOLS = ["read", "ls"] as const;

export interface WikiProducerOptions {
  runLead?: (context: WikiLeadContext) => Promise<void>;
  session?: RunWikiSessionOptions;
  agentsDirectory?: string;
}

export interface WikiLeadContext {
  plan: WikiPinnedSourcePlan;
  candidateRoot: string;
  focus?: string;
  language: "zh" | "en";
  resume: boolean;
  board: WikiBoardStore;
  catalog?: WikiCatalog;
  templates: WikiTemplatePack;
  signal: AbortSignal;
  publish(): Promise<{ ok: boolean; message: string }>;
  check(): Promise<{ ok: boolean; message: string }>;
  note(id: string, agent: string, task: string, status: "running" | "complete" | "failed"): void;
  record(update: SubagentTaskUpdate): Promise<void>;
  observe(event: WikiSessionActivity): void;
}

interface RunArtifactRef {
  path: string;
  sha256: string;
}

interface RunExecutionReceipt {
  id: string;
  boardTaskId: string;
  partition: string;
  agent: string;
  task: string;
  taskDigest: string;
  status: "running" | "complete" | "failed" | "interrupted";
  handoff?: RunArtifactRef;
  startedAt: string;
  completedAt?: string;
  error?: string;
  usage?: WikiAgentUsage;
}

interface RunReviewReceipt {
  executionId: string;
  verdict: "pass" | "changes_requested";
  candidateRevision: string;
  sourceFingerprint: string;
  handoff: RunArtifactRef;
  completedAt: string;
}

interface RunRecord {
  schemaVersion: 2;
  id: string;
  cwd: string;
  status: WikiRunStatus;
  focus?: string;
  language: "zh" | "en";
  createdAt: string;
  updatedAt: string;
  error?: string;
  executions: RunExecutionReceipt[];
  review?: RunReviewReceipt;
  check?: { candidateRevision: string; ok: boolean; completedAt: string; issueCount: number };
  leadAttempts: Array<{ completedAt: string; usage: WikiAgentUsage }>;
  pageCount?: number;
  candidateRoot: string;
  fingerprint: string;
  templateFingerprint?: string;
  sessionFile?: string;
}

const active = new Map<string, LiveRun>();

const TOOL_LIMIT = 12;

interface LiveRun {
  record: RunRecord;
  plan: WikiPinnedSourcePlan;
  controller: AbortController;
  done: Promise<void>;
  result?: WikiProducerResult;
  board?: WikiBoard;
  templates?: WikiTemplatePack;
  candidateRevision?: { digest: string; files: string[] };
  checkpointText?: string;
  recordUpdates: Promise<void>;
  agents: Map<string, WikiAgentView>;
  listeners: Set<(view: WikiRunView) => void>;
}

export function createProductionWikiProducer(options: WikiProducerOptions = {}): WikiProducer {
  return {
    async start(request) {
      const workspace = await loadWikiWorkspace(request.cwd);
      const blocking = (await listRecords(workspace.root)).find((run) => run.status === "running" || run.status === "paused");
      if (blocking) {
        throw new Error(blocking.status === "paused"
          ? `Wiki run ${blocking.id} is paused; use /wiki resume`
          : `Wiki run ${blocking.id} is already running`);
      }
      const plan = await inspectWiki(workspace.root);
      const id = randomUUID().slice(0, 8);
      const candidateRoot = path.join(workspace.root, ".okf-wiki", "runs", id, "candidate");
      await mkdir(candidateRoot, { recursive: true });
      const now = new Date().toISOString();
      const record: RunRecord = {
        schemaVersion: 2,
        id,
        cwd: workspace.root,
        status: "running",
        language: workspace.language,
        ...(request.focus ? { focus: request.focus } : {}),
        createdAt: now,
        updatedAt: now,
        executions: [],
        leadAttempts: [],
        candidateRoot,
        fingerprint: plan.fingerprint,
      };
      await writeRecord(record);
      const live: LiveRun = emptyLive(record, plan);
      startLive(live, workspace, options, { resume: false, focus: request.focus });
      active.set(runKey(workspace.root, id), live);
      return handleFor(live, options, workspace);
    },
    async list(cwd) {
      const workspace = await loadWikiWorkspace(cwd);
      return await Promise.all((await listRecords(workspace.root)).map((record) => toViewFromRecord(record)));
    },
    async open(runId, cwd) {
      const workspace = await loadWikiWorkspace(cwd);
      const live = active.get(runKey(workspace.root, runId));
      if (live) return handleFor(live, options, workspace);
      const record = await readRecord(workspace.root, runId);
      if (!record) return undefined;
      return handleFor(emptyLive(record, await inspectWiki(workspace.root).catch(() => ({
        workspaceRoot: workspace.root,
        workspaceRealPath: workspace.root,
        configPath: workspace.configPath,
        defaultSourceIgnores: workspace.defaultSourceIgnores,
        excludes: workspace.wiki.exclude,
        sources: [],
        fingerprint: record.fingerprint,
      }))), options, workspace);
    },
  };
}

function startLive(
  live: LiveRun,
  workspace: ResolvedWikiWorkspace,
  options: WikiProducerOptions,
  flags: { resume: boolean; focus?: string },
): void {
  const record = live.record;
  const plan = live.plan;
  const controller = new AbortController();
  live.controller = controller;
  live.result = undefined;
  live.agents.set("lead", { id: "lead", agent: "lead", status: "running", tools: [] });
  live.done = (async () => {
    try {
      const initial = emptyBoard(record.focus ?? "Generate a complete repository Wiki");
      const stored = createBoardStore(runDir(record.cwd, record.id), initial);
      const board = watchBoard(stored, live);
      if (!flags.resume) await board.write(initial);
      else live.board = await board.read();
      const catalog = workspace.database
        ? createPostgresCatalog(await resolveWorkspaceDatabase(workspace.database, workspace.root))
        : undefined;
      const templates = await resolveWikiTemplatePack(
        workspace.root,
        workspace.wiki.templates,
        record.language ?? workspace.language,
      );
      live.templates = templates;
      const templatesRevision = templatePackRevision(templates);
      if (record.templateFingerprint && record.templateFingerprint !== templatesRevision) {
        throw new Error("Wiki templates changed; start a new Run instead of resume");
      }
      record.templateFingerprint = templatesRevision;
      if (flags.resume) await reconcileRun(live, board);
      else {
        live.candidateRevision = await candidateRevision(record.candidateRoot);
        await refreshCheckpoint(live, await board.read());
        await writeRecord(record);
      }
      const context: WikiLeadContext = {
        plan,
        candidateRoot: record.candidateRoot,
        focus: flags.focus,
        language: record.language ?? workspace.language,
        resume: flags.resume,
        board,
        templates,
        ...(catalog ? { catalog } : {}),
        signal: controller.signal,
        async publish() {
          return await publishCandidate(live, context.language);
        },
        async check() {
          return await checkCandidate(live);
        },
        note(id, agent, task, status) {
          noteAgent(live, id, agent, task, status);
        },
        async record(update) {
          const transition = live.recordUpdates.then(async () => await recordAgent(live, board, update));
          live.recordUpdates = transition.catch(() => undefined);
          await transition;
        },
        observe(event) {
          observeTool(live, event);
        },
      };
      const runLead = options.runLead ?? defaultRunLead(options, live, workspace.wiki);
      await runLead(context);
      if (live.record.status === "running") {
        const published = await publishCandidate(live, context.language);
        if (!published.ok) throw new Error(published.message);
      }
    } catch (error) {
      if (live.record.status === "paused" || live.record.status === "cancelled") return;
      live.record.status = "failed";
      live.record.error = errorMessage(error);
      live.record.updatedAt = new Date().toISOString();
      settleLead(live, "failed");
      await writeRecord(live.record);
      emit(live);
    }
  })();
}

function defaultRunLead(
  options: WikiProducerOptions,
  live: LiveRun,
  config: WikiWorkspaceWikiConfig,
): (context: WikiLeadContext) => Promise<void> {
  return async (context) => {
    const record = live.record;
    const session: RunWikiSessionOptions = {
      ...options.session,
      transientRetries: config.transientRetries,
      baseRetryDelayMs: config.baseRetryDelayMs,
      sessionTimeoutMs: config.sessionTimeoutSeconds * 1_000,
      onActivity(event) {
        context.observe(event);
      },
    };
    const runtime = await createSubagentRuntime(
      context.plan,
      context.candidateRoot,
      session,
      options.agentsDirectory,
      (update) => context.record(update),
      context.catalog,
      { maxConcurrency: config.maxConcurrentAgents - 1, templates: context.templates },
    );
    const tools: ToolDefinition<any, any, any>[] = [
      ...candidateTools(writeGuardFromPlan(context.plan, context.candidateRoot), LEAD_CANDIDATE_TOOLS),
      createTodoTool(context.board),
      createSubagentTool(runtime),
      createCandidateCheckTool(() => context.check()),
      createPublishTool(() => context.publish()),
    ];
    const prompt = await leadPrompt(context, checkpointFor(live));
    const result = await runWikiSession(context.plan.workspaceRoot, tools, prompt, context.signal, {
      ...session,
      sessionDir: path.join(runDir(record.cwd, record.id), "sessions"),
      sessionFile: record.sessionFile,
      async onSessionReady(sessionFile) {
        if (!sessionFile) return;
        record.sessionFile = sessionFile;
        record.updatedAt = new Date().toISOString();
        await writeRecord(record);
      },
      onCompaction() {
        return checkpointFor(live);
      },
    });
    record.updatedAt = new Date().toISOString();
    if (result.usage) record.leadAttempts.push({ completedAt: record.updatedAt, usage: result.usage });
    await writeRecord(record);
  };
}

function checkpointFor(live: LiveRun): string {
  if (!live.checkpointText) throw new Error("Run checkpoint is unavailable");
  return live.checkpointText;
}

function createCandidateCheckTool(check: () => Promise<{ ok: boolean; message: string }>): ToolDefinition<any, any, any> {
  return {
    name: "candidate_check",
    label: "Check Candidate",
    description: "Run deterministic Candidate validation before semantic review.",
    parameters: Type.Object({}),
    async execute() {
      const result = await check();
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  } as ToolDefinition<any, any, any>;
}

function createPublishTool(publish: () => Promise<{ ok: boolean; message: string }>): ToolDefinition<any, any, any> {
  return {
    name: "publish",
    label: "Publish Wiki",
    description: "Validate the Candidate and install it as wiki/.",
    parameters: Type.Object({}),
    async execute() {
      const result = await publish();
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  } as ToolDefinition<any, any, any>;
}

async function publishCandidate(live: LiveRun, language: "zh" | "en"): Promise<{ ok: boolean; message: string }> {
  const templates = live.templates;
  if (!templates) return { ok: false, message: "Wiki template pack is unavailable" };
  if (live.record.executions.some((entry) => entry.status === "running")) {
    return { ok: false, message: "Cannot publish while subagent executions are running" };
  }
  const validation = await validateAndRecordCandidate(live);
  if (!validation) return { ok: false, message: "Wiki template pack is unavailable" };
  if (!validation.ok) {
    return { ok: false, message: validation.issues.map(formatIssue).join("\n") };
  }
  const receipt = live.record.review;
  if (receipt && receipt.sourceFingerprint !== live.record.fingerprint) {
    return { ok: false, message: "Review is stale; pinned Source fingerprint changed" };
  }
  const review = await assertReviewPass(live.record.candidateRoot, receipt ? {
    verdict: receipt.verdict,
    candidateRevision: receipt.candidateRevision,
    handoffPath: artifactLocation(live, receipt.handoff.path),
    handoffRevision: receipt.handoff.sha256,
  } : undefined);
  if (!review.ok) return review;
  await materializeWikiIndexes(live.record.candidateRoot, language, templates);
  const at = new Date().toISOString();
  await stampPublication(live.record.candidateRoot, at, { reviewed: true, language });
  const wikiRoot = path.join(live.plan.workspaceRoot, "wiki");
  if (await exists(wikiRoot)) await rm(wikiRoot, { recursive: true, force: true });
  await renamePath(live.record.candidateRoot, wikiRoot);
  live.record.status = "succeeded";
  live.record.pageCount = validation.pages.length;
  live.record.updatedAt = at;
  settleLead(live, "complete");
  await writeRecord(live.record);
  emit(live);
  const result = { id: live.record.id, wikiRoot, pages: validation.pages };
  live.result = result;
  return { ok: true, message: `Published ${validation.pages.length} pages to wiki/` };
}

async function checkCandidate(live: LiveRun): Promise<{ ok: boolean; message: string }> {
  const validation = await validateAndRecordCandidate(live);
  if (!validation) return { ok: false, message: "Wiki template pack is unavailable" };
  return validation.ok
    ? { ok: true, message: `Candidate check passed (${validation.pages.length} pages)` }
    : { ok: false, message: validation.issues.map(formatIssue).join("\n") };
}

async function validateAndRecordCandidate(live: LiveRun): Promise<WikiValidation | undefined> {
  await verifyPinnedSourcePlan(live.plan);
  if (!live.templates) return undefined;
  const sources = new Map(live.plan.sources.map((source) => [source.scopeId, source.realPath]));
  const validation = await validateWikiTree(live.record.candidateRoot, sources, live.templates);
  live.candidateRevision = await candidateRevision(live.record.candidateRoot);
  live.record.check = {
    candidateRevision: live.candidateRevision.digest,
    ok: validation.ok,
    issueCount: validation.issues.length,
    completedAt: new Date().toISOString(),
  };
  live.record.updatedAt = new Date().toISOString();
  await writeRecord(live.record);
  await refreshCheckpoint(live);
  return validation;
}

async function recordAgent(live: LiveRun, board: WikiBoardStore, update: SubagentTaskUpdate): Promise<void> {
  const now = new Date().toISOString();
  if (update.status === "running") {
    const currentBoard = await board.read();
    const task = currentBoard.tasks.find((entry) => entry.id === update.boardTaskId);
    if (!task || task.status !== "in_progress") {
      throw new Error(`Subagent execution ${update.id} requires in-progress Board Task ${update.boardTaskId}`);
    }
    if (live.record.executions.some((entry) => entry.id === update.id)) {
      throw new Error(`Duplicate subagent execution id ${update.id}`);
    }
    live.record.executions.push({
      id: update.id,
      boardTaskId: update.boardTaskId,
      partition: update.partition,
      agent: update.agent,
      task: update.task,
      taskDigest: digestText(update.task),
      status: "running",
      startedAt: now,
    });
    if (update.agent === "review") live.record.review = undefined;
    live.record.updatedAt = now;
    await writeRecord(live.record);
    await refreshCheckpoint(live, currentBoard);
    noteAgent(live, update.id, update.agent, update.task, "running");
    return;
  }

  const receipt = live.record.executions.find((entry) => entry.id === update.id);
  if (!receipt) throw new Error(`Missing running receipt for subagent execution ${update.id}`);
  receipt.status = update.status;
  receipt.completedAt = now;
  receipt.error = update.error;
  receipt.usage = update.usage;
  if (update.handoff && update.handoffRevision) {
    try {
      const revision = await fileRevision(artifactLocation(live, update.handoff));
      if (revision !== update.handoffRevision) throw new Error("Handoff digest does not match the terminal update");
      receipt.handoff = { path: update.handoff, sha256: revision };
    } catch (error) {
      receipt.status = "failed";
      receipt.error = errorMessage(error);
    }
  }
  if (update.agent !== "survey") {
    live.candidateRevision = await candidateRevision(live.record.candidateRoot);
  }
  live.candidateRevision ??= await candidateRevision(live.record.candidateRoot);
  if (update.candidateRevision && update.agent !== "survey" && update.candidateRevision !== live.candidateRevision.digest) {
    receipt.status = "failed";
    receipt.error = "Candidate digest does not match the terminal update";
  }
  if (update.agent === "review" && receipt.status === "complete" && receipt.handoff && update.text) {
    try {
      const verdict = parseReviewVerdict(update.text);
      live.record.review = {
        executionId: update.id,
        verdict,
        candidateRevision: live.candidateRevision.digest,
        sourceFingerprint: live.record.fingerprint,
        handoff: receipt.handoff,
        completedAt: now,
      };
    } catch (error) {
      receipt.status = "failed";
      receipt.error = errorMessage(error);
    }
  }
  live.record.updatedAt = now;
  await writeRecord(live.record);
  await reconcileBoardTask(live, board, update.boardTaskId);
  await refreshCheckpoint(live, await board.read());
  noteAgent(live, update.id, update.agent, update.task, receipt.status);
  emit(live);
}

async function reconcileRun(live: LiveRun, board: WikiBoardStore): Promise<void> {
  let changed = false;
  live.candidateRevision = await candidateRevision(live.record.candidateRoot);
  for (const receipt of live.record.executions) {
    if (receipt.status === "running") {
      if (await adoptCompletedHandoff(live, receipt)) {
        changed = true;
        continue;
      }
      receipt.status = "interrupted";
      receipt.completedAt = new Date().toISOString();
      receipt.error = "Execution was interrupted before a terminal receipt was persisted";
      const agent = live.agents.get(receipt.id);
      if (agent) live.agents.set(receipt.id, { ...agent, status: "failed" });
      changed = true;
    }
    if (receipt.status === "complete" && !receipt.handoff) {
      receipt.status = "failed";
      receipt.error = "Completed execution has no attested handoff";
      changed = true;
    } else if (receipt.status === "complete" && receipt.handoff) {
      try {
        if (await fileRevision(artifactLocation(live, receipt.handoff.path)) !== receipt.handoff.sha256) {
          receipt.status = "failed";
          receipt.error = "Handoff content no longer matches its receipt";
          changed = true;
        }
      } catch {
        receipt.status = "failed";
        receipt.error = "Handoff referenced by the receipt is missing";
        changed = true;
      }
    }
  }
  for (const taskId of new Set(live.record.executions.map((entry) => entry.boardTaskId))) {
    await reconcileBoardTask(live, board, taskId, true);
  }
  if (changed) {
    live.record.updatedAt = new Date().toISOString();
    await writeRecord(live.record);
  }
  await refreshCheckpoint(live, await board.read());
}

async function adoptCompletedHandoff(live: LiveRun, receipt: RunExecutionReceipt): Promise<boolean> {
  const relative = path.relative(
    live.record.cwd,
    path.join(runDir(live.record.cwd, live.record.id), "handoffs", `${receipt.id}.md`),
  ).replaceAll("\\", "/");
  const location = artifactLocation(live, relative);
  let text: string;
  try {
    text = await readFile(location, "utf8");
  } catch {
    return false;
  }
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const match = /^<!-- wiki-handoff (\{.*\}) -->$/.exec(first);
  if (!match) return false;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (
    metadata.executionId !== receipt.id
    || metadata.boardTaskId !== receipt.boardTaskId
    || metadata.partition !== receipt.partition
    || metadata.agent !== receipt.agent
    || metadata.taskDigest !== receipt.taskDigest
  ) return false;
  if ((receipt.agent === "write" || receipt.agent === "review")
    && metadata.completedCandidateRevision !== live.candidateRevision?.digest) return false;
  if (receipt.agent === "review" && metadata.baseCandidateRevision !== live.candidateRevision?.digest) return false;
  const bodyMarker = "<!-- wiki-handoff-body -->\n";
  const bodyOffset = text.lastIndexOf(bodyMarker);
  const reviewBody = bodyOffset >= 0 ? text.slice(bodyOffset + bodyMarker.length) : undefined;
  const reviewVerdict = receipt.agent === "review" && reviewBody ? safeReviewVerdict(reviewBody) : undefined;
  if (receipt.agent === "review" && !reviewVerdict) return false;

  const now = new Date().toISOString();
  receipt.status = "complete";
  receipt.completedAt = now;
  receipt.handoff = { path: relative, sha256: await fileRevision(location) };
  receipt.error = undefined;
  if (receipt.agent === "review") {
    if (!reviewVerdict || !live.candidateRevision) return false;
    live.record.review = {
      executionId: receipt.id,
      verdict: reviewVerdict,
      candidateRevision: live.candidateRevision.digest,
      sourceFingerprint: live.record.fingerprint,
      handoff: receipt.handoff,
      completedAt: now,
    };
  }
  return true;
}

async function reconcileBoardTask(
  live: LiveRun,
  board: WikiBoardStore,
  taskId: string,
  resume = false,
): Promise<void> {
  const current = await board.read();
  const target = current.tasks.find((task) => task.id === taskId);
  if (!target) return;
  const attempts = latestExecutions(live.record.executions.filter((entry) => entry.boardTaskId === taskId));
  if (!attempts.length || attempts.some((entry) => entry.status === "running")) return;
  const complete = attempts.every((entry) => entry.status === "complete");
  const artifacts = attempts.flatMap((entry) => entry.handoff ? [entry.handoff.path] : []);
  const failures = attempts.filter((entry) => entry.status === "failed" || entry.status === "interrupted");
  const status: WikiBoard["tasks"][number]["status"] = complete ? "completed" : resume ? "pending" : "failed";
  const note = complete
    ? artifacts.length ? `handoff: ${artifacts.join(", ")}` : "execution receipts complete"
    : failures.map((entry) => `${entry.partition}: ${entry.error ?? entry.status}`).join("; ");
  const tasks = current.tasks.map((task) => task.id === taskId ? { ...task, status, ...(note ? { note } : {}) } : task);
  await board.write(replaceBoard(current, { tasks }));
}

function latestExecutions(executions: readonly RunExecutionReceipt[]): RunExecutionReceipt[] {
  const latest = new Map<string, RunExecutionReceipt>();
  for (const execution of executions) {
    const key = `${execution.boardTaskId}\0${execution.partition}`;
    const current = latest.get(key);
    if (!current || execution.startedAt >= current.startedAt) latest.set(key, execution);
  }
  return [...latest.values()];
}

async function refreshCheckpoint(live: LiveRun, board = live.board): Promise<void> {
  if (!board) return;
  live.candidateRevision ??= await candidateRevision(live.record.candidateRoot);
  const review = live.record.review;
  const checkpointReview: CheckpointReview | undefined = review ? {
    verdict: review.verdict,
    candidateRevision: review.candidateRevision,
    status: review.sourceFingerprint === live.record.fingerprint && review.candidateRevision === live.candidateRevision.digest
      ? "current"
      : "stale",
    handoff: review.handoff,
  } : undefined;
  const executions: CheckpointExecution[] = latestExecutions(live.record.executions).map((entry) => ({
    id: entry.id,
    boardTaskId: entry.boardTaskId,
    partition: entry.partition,
    agent: entry.agent,
    status: entry.status,
    ...(entry.handoff ? { handoff: entry.handoff } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  }));
  live.checkpointText = formatLeadCheckpoint({
    runId: live.record.id,
    ...(live.record.focus ? { focus: live.record.focus } : {}),
    board,
    sourceFingerprint: live.record.fingerprint,
    ...(live.record.templateFingerprint ? { templateFingerprint: live.record.templateFingerprint } : {}),
    candidateRevision: live.candidateRevision.digest,
    pageCount: live.candidateRevision.files.length,
    executions,
    ...(checkpointReview ? { review: checkpointReview } : {}),
    ...(live.record.check ? { check: {
      ...live.record.check,
      status: live.record.check.candidateRevision === live.candidateRevision.digest ? "current" as const : "stale" as const,
    } } : {}),
  });
}

function parseReviewVerdict(text: string): "pass" | "changes_requested" {
  const first = text.trimStart().split(/\r?\n/, 1)[0]?.trim();
  const match = /^verdict:\s*(pass|changes_requested)$/.exec(first ?? "");
  if (!match) throw new Error("Review handoff must start with verdict: pass or verdict: changes_requested");
  return match[1] as "pass" | "changes_requested";
}

function safeReviewVerdict(text: string): "pass" | "changes_requested" | undefined {
  try {
    return parseReviewVerdict(text);
  } catch {
    return undefined;
  }
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactLocation(live: LiveRun, relative: string): string {
  const root = path.resolve(runDir(live.record.cwd, live.record.id));
  const location = path.resolve(live.record.cwd, ...relative.split("/"));
  if (location !== root && !location.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Artifact path escapes the Run: ${relative}`);
  }
  return location;
}

function handleFor(live: LiveRun, options: WikiProducerOptions, workspace: ResolvedWikiWorkspace): WikiRunHandle {
  return {
    id: live.record.id,
    async view() {
      return await toView(live);
    },
    subscribe(listener) {
      live.listeners.add(listener);
      void toView(live).then((view) => {
        if (live.listeners.has(listener)) listener(view);
      });
      return () => { live.listeners.delete(listener); };
    },
    async control(action: WikiRunControl) {
      if (action === "resume") {
        await resumeLive(live, options, workspace);
        return await toView(live);
      }
      if (action === "pause") {
        live.record.status = "paused";
        live.controller.abort();
      } else if (action === "cancel") {
        live.record.status = "cancelled";
        live.controller.abort();
        settleLead(live, "failed");
      }
      live.record.updatedAt = new Date().toISOString();
      await writeRecord(live.record);
      emit(live);
      return await toView(live);
    },
    async result() {
      await live.done;
      if (live.result) return live.result;
      throw new WikiRunResultError(live.record.error ?? `Wiki run ${live.record.id} ${live.record.status}`, await toView(live));
    },
  };
}

async function resumeLive(
  live: LiveRun,
  options: WikiProducerOptions,
  workspace: ResolvedWikiWorkspace,
): Promise<void> {
  const key = runKey(workspace.root, live.record.id);
  if (live.record.status === "running" && active.get(key) === live) return;
  if (live.record.status !== "running" && live.record.status !== "paused" && live.record.status !== "failed") {
    throw new Error(`Cannot resume a ${live.record.status} Wiki run`);
  }
  if (active.get(key) === live) await live.done;
  if (!await exists(live.record.candidateRoot)) {
    throw new Error(`Wiki run ${live.record.id} has no Candidate to continue`);
  }
  const plan = await inspectWiki(workspace.root);
  if (plan.fingerprint !== live.record.fingerprint) {
    throw new Error("Pinned sources changed; start a new Run instead of resume");
  }
  await verifyPinnedSourcePlan(plan);
  live.plan = plan;
  live.record.status = "running";
  live.record.error = undefined;
  live.record.updatedAt = new Date().toISOString();
  await writeRecord(live.record);
  startLive(live, workspace, options, { resume: true, focus: live.record.focus });
  active.set(key, live);
}

async function toView(live: LiveRun): Promise<WikiRunView> {
  return toViewFrom(live.record, live.board ?? await createBoardStore(runDir(live.record.cwd, live.record.id)).read(), live.agents);
}

async function toViewFromRecord(record: RunRecord): Promise<WikiRunView> {
  return toViewFrom(record, await createBoardStore(runDir(record.cwd, record.id)).read(), new Map());
}

function toViewFrom(record: RunRecord, board: WikiBoard, agents: Map<string, WikiAgentView>): WikiRunView {
  return {
    id: record.id,
    cwd: record.cwd,
    status: record.status,
    ...(record.focus ? { focus: record.focus } : {}),
    ...(board.goal ? { goal: board.goal } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.error ? { error: record.error } : {}),
    agents: presentAgents(record, agents),
    ...(board.tasks.length ? { tasks: board.tasks } : {}),
    ...(record.pageCount !== undefined ? { pageCount: record.pageCount } : {}),
  };
}

function presentAgents(record: RunRecord, live: Map<string, WikiAgentView>): WikiAgentView[] {
  if (live.size > 0) {
    const lead = live.get("lead");
    const rest = [...live.values()].filter((agent) => agent.id !== "lead" && agent.agent !== "lead");
    return lead ? [lead, ...rest] : rest;
  }
  const leadStatus = record.status === "succeeded"
    ? "complete"
    : record.status === "running" || record.status === "paused"
      ? "running"
      : "failed";
  return [
    { id: "lead", agent: "lead", status: leadStatus, tools: [] },
    ...record.executions.map((execution) => ({
      id: execution.id,
      agent: execution.agent,
      task: execution.task,
      status: execution.status === "interrupted" ? "failed" as const : execution.status,
      ...(execution.usage ? { usage: execution.usage } : {}),
      tools: [],
    })),
  ];
}

function emptyLive(record: RunRecord, plan: WikiPinnedSourcePlan): LiveRun {
  return {
    record,
    plan,
    controller: new AbortController(),
    done: Promise.resolve(),
    recordUpdates: Promise.resolve(),
    agents: new Map(),
    listeners: new Set(),
  };
}

function watchBoard(store: WikiBoardStore, live: LiveRun): WikiBoardStore {
  return {
    path: store.path,
    async read() {
      const board = await store.read();
      live.board = board;
      return board;
    },
    async write(board) {
      live.board = await store.write(board);
      live.record.updatedAt = new Date().toISOString();
      await refreshCheckpoint(live, live.board);
      await writeRecord(live.record);
      emit(live);
      return live.board;
    },
  };
}

function noteAgent(live: LiveRun, id: string, agent: string, task: string, status: WikiAgentView["status"]): void {
  const current = live.agents.get(id) ?? { id, agent, tools: [] as WikiToolView[] };
  live.agents.set(id, { ...current, id, agent, task, status, tools: current.tools });
  live.record.updatedAt = new Date().toISOString();
  emit(live);
}

function observeTool(live: LiveRun, event: WikiSessionActivity): void {
  const id = event.scope ?? "lead";
  const current = live.agents.get(id) ?? { id, agent: id === "lead" ? "lead" : id, status: "running" as const, tools: [] as WikiToolView[] };
  const tools = current.tools.slice();
  const index = tools.findIndex((tool) => tool.id === event.id);
  const row: WikiToolView = { id: event.id, tool: event.tool, args: event.args, status: event.status };
  if (index >= 0) tools[index] = row;
  else tools.push(row);
  live.agents.set(id, {
    ...current,
    id,
    status: current.status === "complete" || current.status === "failed" ? current.status : "running",
    tools: capTools(tools),
    ...(event.usage ? { usage: event.usage } : {}),
  });
  live.record.updatedAt = new Date().toISOString();
  emit(live);
}

function capTools(tools: WikiToolView[]): WikiToolView[] {
  const running = tools.filter((tool) => tool.status === "running");
  if (tools.length <= Math.max(TOOL_LIMIT, running.length)) return tools;
  const keep = new Set(running.map((tool) => tool.id));
  for (const tool of tools.slice().reverse()) {
    if (keep.size >= Math.max(TOOL_LIMIT, running.length)) break;
    keep.add(tool.id);
  }
  return tools.filter((tool) => keep.has(tool.id));
}

function settleLead(live: LiveRun, status: WikiAgentView["status"]): void {
  const lead = live.agents.get("lead") ?? { id: "lead", agent: "lead", tools: [] as WikiToolView[] };
  live.agents.set("lead", { ...lead, id: "lead", agent: "lead", status, tools: lead.tools });
}

function emit(live: LiveRun): void {
  if (live.listeners.size === 0) return;
  void toView(live).then((view) => {
    for (const listener of live.listeners) listener(view);
  });
}

function runKey(cwd: string, id: string): string {
  return `${path.resolve(cwd)}:${id}`;
}

function runDir(cwd: string, id: string): string {
  return path.join(cwd, ".okf-wiki", "runs", id);
}

async function writeRecord(record: RunRecord): Promise<void> {
  await mkdir(runDir(record.cwd, record.id), { recursive: true });
  await writeText(path.join(runDir(record.cwd, record.id), "run.json"), `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord(cwd: string, id: string): Promise<RunRecord | undefined> {
  try {
    return normalizeRunRecord(JSON.parse(await readFile(path.join(runDir(cwd, id), "run.json"), "utf8")));
  } catch {
    return undefined;
  }
}

async function listRecords(cwd: string): Promise<RunRecord[]> {
  const root = path.join(cwd, ".okf-wiki", "runs");
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const name of names) {
    const record = await readRecord(cwd, name);
    if (record) records.push(record);
  }
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizeRunRecord(value: unknown): RunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run record must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2) {
    throw new Error(`Unsupported Run record schema version: ${String(raw.schemaVersion)}`);
  }
  if (raw.schemaVersion === 2) {
    if (!Array.isArray(raw.executions)) throw new Error("Run record executions must be an array");
    if (!Array.isArray(raw.leadAttempts)) raw.leadAttempts = [];
    return raw as unknown as RunRecord;
  }
  const focus = typeof raw.focus === "string" ? raw.focus : undefined;
  return {
    ...(raw as unknown as Omit<RunRecord, "schemaVersion" | "executions" | "leadAttempts">),
    schemaVersion: 2,
    executions: [],
    leadAttempts: [],
    ...(focus ? { focus } : {}),
  };
}

async function leadPrompt(context: WikiLeadContext, checkpoint: string): Promise<string> {
  const body = await readFile(fileURLToPath(new URL("../../../prompts/lead.md", import.meta.url)), "utf8");
  const sources = context.plan.sources.map((source) => `- ${source.scopeId}: ${source.logicalPath}`).join("\n");
  const focus = context.focus ? `\nFocus: ${context.focus}\n` : "";
  const agents = "Available agents: survey, write, review. Every assignment requires an existing in-progress boardTaskId and a stable partition. Survey assignments may be batched; write and review run alone.\n";
  const resume = context.resume
    ? "\nThis is a resumed Run. Reconcile the checkpoint and durable artifacts before doing more work. Do not restart completed partitions.\n"
    : "";
  return `${body}\n\n# This run\n\nLanguage: ${context.language}.${focus}${resume}${agents}\nPinned sources:\n${sources}\n\n${checkpoint}\n`;
}
