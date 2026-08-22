import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { inspectWiki, pinsFromPlan, verifyPinnedSourcePlan, type WikiPinnedSourcePlan } from "./inspect.js";
import { taskDigest, verifyHandoff } from "./handoff.js";
import { ensureDirectory, exists, removePath, withExclusiveLock, writeText } from "./files.js";
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
import { createSubagentRuntime, createSubagentTool, type SubagentTask, type SubagentTaskUpdate } from "./subagent.js";
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
import { candidatePartitionRevision, candidateRevision, fileRevision, templatePackRevision } from "./revisions.js";
import { formatLeadCheckpoint, type CheckpointExecution, type CheckpointReview } from "./checkpoint.js";
import { installWikiPublication, recoverWikiPublication } from "./publication.js";

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
  assertDispatch(tasks: readonly SubagentTask[]): void;
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
  schemaVersion: 3;
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
  check?: { candidateRevision: string; ok: boolean; completedAt: string; issueCount: number; issueDigest: string };
  leadAttempts: Array<{ completedAt: string; usage: WikiAgentUsage }>;
  pageCount?: number;
  candidateRoot: string;
  fingerprint: string;
  plan: WikiPinnedSourcePlan;
  templateFingerprint?: string;
  finalizedRevision?: string;
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
  catalogAvailable?: boolean;
  candidateRevision?: { digest: string; files: string[] };
  checkpointText?: string;
  recordUpdates: Promise<void>;
  agents: Map<string, WikiAgentView>;
  listeners: Set<(view: WikiRunView) => void>;
  ownerToken?: string;
}

export function createProductionWikiProducer(options: WikiProducerOptions = {}): WikiProducer {
  return {
    async start(request) {
      const workspace = await loadWikiWorkspace(request.cwd);
      return await withExclusiveLock(transitionLock(workspace.root), async () => {
        await recoverWikiPublication(workspace.root);
        await reconcileRecoveredPublication(workspace.root);
        const key = runKey(workspace.root);
        const inMemory = active.get(key);
        if (inMemory?.record.status === "running" || inMemory?.record.status === "paused") {
          throw blockingRunError(inMemory.record);
        }
        await discardLegacyRuns(workspace.root);
        let current: RunRecord | undefined;
        try { current = await readRecord(workspace.root); }
        catch { await cleanupCurrentRun(workspace.root); }
        if (current?.status === "running" || current?.status === "paused") throw blockingRunError(current);
        await cleanupCurrentRun(workspace.root);
        const plan = await inspectWiki(workspace.root);
        const id = randomUUID().slice(0, 8);
        const candidateRoot = path.join(runDir(workspace.root), "candidate");
        await ensureDirectory(candidateRoot);
        const now = new Date().toISOString();
        const record: RunRecord = {
          schemaVersion: 3,
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
          plan,
        };
        await writeRecord(record);
        const live: LiveRun = emptyLive(record, plan);
        await claimRunOwner(live);
        active.set(key, live);
        startLive(live, workspace, options, { resume: false, focus: request.focus });
        return handleFor(live, options, workspace);
      });
    },
    async current(cwd) {
      const workspace = await loadWikiWorkspace(cwd);
      await recoverWikiPublication(workspace.root);
      await reconcileRecoveredPublication(workspace.root);
      const live = active.get(runKey(workspace.root));
      if (live) return handleFor(live, options, workspace);
      let record: RunRecord | undefined;
      try { record = await readRecord(workspace.root); }
      catch {
        await cleanupCurrentRun(workspace.root);
        return undefined;
      }
      if (!record) return undefined;
      return handleFor(emptyLive(record, record.plan), options, workspace);
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
      const stored = createBoardStore(runDir(record.cwd), initial);
      const board = watchBoard(stored, live);
      if (!flags.resume) await board.write(initial);
      else live.board = await board.read();
      const catalog = workspace.database
        ? createPostgresCatalog(await resolveWorkspaceDatabase(workspace.database, workspace.root))
        : undefined;
      live.catalogAvailable = Boolean(catalog);
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
          return await publishCandidate(live);
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
        assertDispatch(tasks) {
          const issue = fanInIssue(live, tasks);
          if (issue) throw new Error(issue);
        },
      };
      const runLead = options.runLead ?? defaultRunLead(options, live, workspace.wiki);
      await runLead(context);
      if (live.record.status === "running") {
        const published = await publishCandidate(live);
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
    finally {
      await releaseRunOwner(live);
      if (record.status === "succeeded" || record.status === "cancelled") {
        await cleanupCurrentRun(record.cwd);
      }
      if (record.status !== "running" && record.status !== "paused") {
        const key = runKey(record.cwd);
        if (active.get(key) === live) active.delete(key);
      }
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
      {
        maxConcurrency: config.maxConcurrentAgents - 1,
        maxEvidenceRepairRounds: config.maxEvidenceRepairRounds,
        templates: context.templates,
        assertDispatch: context.assertDispatch,
      },
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
      sessionDir: path.join(runDir(record.cwd), "sessions"),
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

async function publishCandidate(live: LiveRun): Promise<{ ok: boolean; message: string }> {
  if (live.record.executions.some((entry) => entry.status === "running")) {
    return { ok: false, message: "Cannot publish while subagent executions are running" };
  }
  const workflowIssue = fanInIssue(live);
  if (workflowIssue) return { ok: false, message: workflowIssue };
  const validation = await validateAndRecordCandidate(live);
  if (!validation) return { ok: false, message: "Wiki template pack is unavailable" };
  if (!validation.ok) {
    return { ok: false, message: validation.issues.map(formatIssue).join("\n") };
  }
  if (!live.candidateRevision || live.record.finalizedRevision !== live.candidateRevision.digest) {
    return { ok: false, message: "Candidate must pass candidate_check after its final write and before review" };
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
  const at = new Date().toISOString();
  const wikiRoot = path.join(live.plan.workspaceRoot, "wiki");
  await installWikiPublication(live.plan.workspaceRoot, live.record.candidateRoot);
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
  const templates = live.templates;
  if (!templates) return { ok: false, message: "Wiki template pack is unavailable" };
  const initial = await validateAndRecordCandidate(live);
  if (!initial) return { ok: false, message: "Wiki template pack is unavailable" };
  if (!initial.ok) {
    live.record.finalizedRevision = undefined;
    await writeRecord(live.record);
    return { ok: false, message: initial.issues.map(formatIssue).join("\n") };
  }
  await materializeWikiIndexes(
    live.record.candidateRoot,
    live.record.language,
    templates,
    pinsFromPlan(live.plan),
  );
  await stampPublication(live.record.candidateRoot, new Date().toISOString(), { reviewed: true, language: live.record.language });
  const validation = await validateAndRecordCandidate(live);
  if (!validation) return { ok: false, message: "Wiki template pack is unavailable" };
  if (validation.ok && live.candidateRevision) {
    live.record.finalizedRevision = live.candidateRevision.digest;
  } else {
    live.record.finalizedRevision = undefined;
  }
  await writeRecord(live.record);
  await refreshCheckpoint(live);
  return validation.ok
    ? { ok: true, message: `Candidate check passed (${validation.pages.length} pages)` }
    : { ok: false, message: validation.issues.map(formatIssue).join("\n") };
}

async function validateAndRecordCandidate(live: LiveRun): Promise<WikiValidation | undefined> {
  await verifyPinnedSourcePlan(live.plan);
  if (!live.templates) return undefined;
  const validation = await validateWikiTree(live.record.candidateRoot, pinsFromPlan(live.plan), live.templates, {
    catalogAvailable: live.catalogAvailable,
  });
  live.candidateRevision = await candidateRevision(live.record.candidateRoot);
  live.record.check = {
    candidateRevision: live.candidateRevision.digest,
    ok: validation.ok,
    issueCount: validation.issues.length,
    issueDigest: validationIssueDigest(validation),
    completedAt: new Date().toISOString(),
  };
  live.record.updatedAt = new Date().toISOString();
  await writeRecord(live.record);
  await refreshCheckpoint(live);
  return validation;
}

function fanInIssue(live: LiveRun, incoming?: readonly SubagentTask[]): string | undefined {
  if (live.plan.sources.length <= 1) return undefined;
  const latest = (agent: string, partition: string) => live.record.executions
    .filter((entry) => entry.agent === agent && entry.partition === partition)
    .reduce<RunExecutionReceipt | undefined>((current, entry) => (
      !current || entry.startedAt >= current.startedAt ? entry : current
    ), undefined);
  const surveys = live.plan.sources.map((source) => latest("survey", source.scopeId));
  const missing = live.plan.sources
    .filter((_source, index) => (
      surveys[index]?.status !== "complete" || !surveys[index]?.handoff || !surveys[index]?.completedAt
    ))
    .map((source) => source.scopeId);
  const synthesis = latest("synthesize", "workspace-analysis");
  const agents = incoming ? new Set(incoming.map((task) => task.agent)) : undefined;
  if (agents?.has("survey")) return undefined;
  if (agents?.has("synthesize") || !agents) {
    if (missing.length) return `Cross-Source analysis requires completed surveys for: ${missing.join(", ")}`;
  }
  if (agents?.has("synthesize")) {
    const task = incoming!.map((entry) => entry.task).join("\n");
    const omittedHandoffs = surveys
      .filter((entry) => entry?.handoff && !task.includes(entry.handoff.path))
      .map((entry) => entry!.partition);
    if (omittedHandoffs.length) {
      return `Cross-Source synthesis task must name every survey handoff; missing ${omittedHandoffs.join(", ")}`;
    }
    return undefined;
  }
  if (synthesis?.status !== "complete" || !synthesis.handoff || !synthesis.completedAt) {
    return "Multi-Source Workspace requires one completed synthesize execution for partition workspace-analysis";
  }
  if (agents?.has("write")) return undefined;
  const omittedHandoffs = surveys
    .filter((entry) => entry?.handoff && !synthesis.task.includes(entry.handoff.path))
    .map((entry) => entry!.partition);
  if (omittedHandoffs.length) {
    return `Cross-Source synthesis task must name every survey handoff; missing ${omittedHandoffs.join(", ")}`;
  }
  const lastSurvey = surveys.reduce((latestAt, entry) => {
    const completedAt = entry?.completedAt ?? "";
    return completedAt > latestAt ? completedAt : latestAt;
  }, "");
  if (synthesis.startedAt < lastSurvey) {
    return "Cross-Source synthesis must start after every Source survey completes";
  }
  const earlyWrite = live.record.executions.find((entry) => entry.agent === "write" && entry.startedAt < (synthesis.completedAt ?? ""));
  if (earlyWrite) return `Write partition ${earlyWrite.partition} started before cross-Source synthesis completed`;
  return undefined;
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
      taskDigest: taskDigest(update.task),
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
  if (update.agent !== "survey") {
    live.candidateRevision = await candidateRevision(live.record.candidateRoot);
  }
  if (update.agent === "write") live.record.finalizedRevision = undefined;
  live.candidateRevision ??= await candidateRevision(live.record.candidateRoot);
  if (update.status === "complete") {
    const completedRevision = update.agent === "write"
      ? await candidatePartitionRevision(live.record.candidateRoot, update.partition)
      : live.candidateRevision;
    let verified;
    try {
      verified = update.handoff
        ? await verifyHandoff(artifactLocation(live, update.handoff), {
          executionId: update.id,
          boardTaskId: update.boardTaskId,
          partition: update.partition,
          agent: update.agent,
          taskDigest: receipt.taskDigest,
          candidateRevision: completedRevision.digest,
        })
        : undefined;
    } catch (error) {
      receipt.status = "failed";
      receipt.error = errorMessage(error);
      verified = undefined;
    }
    if (receipt.status === "complete" && !verified) {
      receipt.status = "failed";
      receipt.error = "Handoff is missing or does not match the execution receipt";
    } else if (verified && update.handoff) {
      receipt.handoff = { path: update.handoff, sha256: verified.sha256 };
      if (update.agent === "review") {
        live.record.review = {
          executionId: update.id,
          verdict: verified.verdict!,
          candidateRevision: live.candidateRevision.digest,
          sourceFingerprint: live.record.fingerprint,
          handoff: receipt.handoff,
          completedAt: now,
        };
      }
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
    path.join(runDir(live.record.cwd), "handoffs", `${receipt.id}.md`),
  ).replaceAll("\\", "/");
  const completedRevision = receipt.agent === "write"
    ? await candidatePartitionRevision(live.record.candidateRoot, receipt.partition)
    : live.candidateRevision;
  let verified;
  try {
    verified = await verifyHandoff(artifactLocation(live, relative), {
      executionId: receipt.id,
      boardTaskId: receipt.boardTaskId,
      partition: receipt.partition,
      agent: receipt.agent,
      taskDigest: receipt.taskDigest,
      candidateRevision: completedRevision?.digest,
    });
  } catch {
    return false;
  }
  if (!verified) return false;
  const now = new Date().toISOString();
  receipt.status = "complete";
  receipt.completedAt = now;
  receipt.handoff = { path: relative, sha256: verified.sha256 };
  receipt.error = undefined;
  if (receipt.agent === "review") {
    if (!verified.verdict || !live.candidateRevision) return false;
    live.record.review = {
      executionId: receipt.id,
      verdict: verified.verdict,
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
  const failures = attempts.filter((entry) => entry.status === "failed" || entry.status === "interrupted");
  const status: WikiBoard["tasks"][number]["status"] = complete ? "completed" : resume ? "pending" : "failed";
  const note = complete
    ? "execution receipts complete"
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

function validationIssueDigest(validation: WikiValidation): string {
  return createHash("sha256")
    .update(validation.issues
      .map((issue) => `${issue.code}\0${issue.page ?? ""}\0${issue.message}`)
      .sort()
      .join("\n"))
    .digest("hex");
}

function artifactLocation(live: LiveRun, relative: string): string {
  const root = path.resolve(runDir(live.record.cwd));
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
        if (live.record.status !== "paused" && live.record.status !== "failed" && live.record.status !== "running") {
          throw new Error(`Cannot resume a ${live.record.status} Wiki run`);
        }
        await resumeLive(live, options, workspace);
        return await toView(live);
      }
      await withExclusiveLock(transitionLock(workspace.root), async () => {
        await assertRunOwnerAvailable(live);
        if (action === "pause") {
          if (live.record.status !== "running") throw new Error(`Cannot pause a ${live.record.status} Wiki run`);
          live.record.status = "paused";
          live.controller.abort();
        } else if (action === "cancel") {
          if (live.record.status !== "running" && live.record.status !== "paused" && live.record.status !== "failed") {
            throw new Error(`Cannot cancel a ${live.record.status} Wiki run`);
          }
          live.record.status = "cancelled";
          live.controller.abort();
          settleLead(live, "failed");
        }
        live.record.updatedAt = new Date().toISOString();
        await writeRecord(live.record);
        emit(live);
      });
      if (action === "cancel" && active.get(runKey(workspace.root)) !== live) {
        await cleanupCurrentRun(workspace.root);
      }
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
  const key = runKey(workspace.root);
  if (live.record.status === "running" && active.get(key) === live) return;
  if (live.record.status !== "running" && live.record.status !== "paused" && live.record.status !== "failed") {
    throw new Error(`Cannot resume a ${live.record.status} Wiki run`);
  }
  if (active.get(key) === live) await live.done;
  await withExclusiveLock(transitionLock(workspace.root), async () => {
    await assertRunOwnerAvailable(live);
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
    await claimRunOwner(live);
    active.set(key, live);
    startLive(live, workspace, options, { resume: true, focus: live.record.focus });
  });
}

async function toView(live: LiveRun): Promise<WikiRunView> {
  return toViewFrom(live.record, live.board ?? await createBoardStore(runDir(live.record.cwd)).read(), live.agents);
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

function runKey(cwd: string): string {
  return path.resolve(cwd);
}

function runDir(cwd: string): string {
  return path.join(cwd, ".okf-wiki", "run");
}

async function writeRecord(record: RunRecord): Promise<void> {
  await ensureDirectory(runDir(record.cwd));
  await writeText(path.join(runDir(record.cwd), "run.json"), `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord(cwd: string): Promise<RunRecord | undefined> {
  try {
    return normalizeRunRecord(JSON.parse(await readFile(path.join(runDir(cwd), "run.json"), "utf8")), cwd);
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function normalizeRunRecord(value: unknown, cwd: string): RunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run record must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 3) {
    throw new Error(`Unsupported Run record schema version: ${String(raw.schemaVersion)}`);
  }
  const root = path.resolve(cwd);
  if (raw.cwd !== root) throw new Error("Run record cwd does not match the Workspace");
  if (raw.candidateRoot !== path.join(runDir(root), "candidate")) throw new Error("Run record Candidate path is invalid");
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.id)) throw new Error("Run record id is invalid");
  if (!isRunStatus(raw.status)) throw new Error("Run record status is invalid");
  if (raw.language !== "zh" && raw.language !== "en") throw new Error("Run record language is invalid");
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) throw new Error("Run record timestamps are invalid");
  if (typeof raw.fingerprint !== "string") throw new Error("Run record fingerprint is invalid");
  if (!Array.isArray(raw.executions) || !raw.executions.every(isExecutionReceipt)) throw new Error("Run record executions are invalid");
  if (!Array.isArray(raw.leadAttempts) || !raw.leadAttempts.every(isLeadAttempt)) throw new Error("Run record leadAttempts are invalid");
  if (!isPinnedPlan(raw.plan) || path.resolve(raw.plan.workspaceRoot) !== root || raw.plan.fingerprint !== raw.fingerprint) {
    throw new Error("Run record plan is invalid");
  }
  if (raw.review !== undefined && !isReviewReceipt(raw.review)) throw new Error("Run record review is invalid");
  if (raw.check !== undefined && !isCheckReceipt(raw.check)) throw new Error("Run record check is invalid");
  for (const key of ["focus", "error", "templateFingerprint", "finalizedRevision", "sessionFile"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`Run record ${key} is invalid`);
  }
  if (raw.pageCount !== undefined && (!Number.isInteger(raw.pageCount) || (raw.pageCount as number) < 0)) {
    throw new Error("Run record pageCount is invalid");
  }
  return raw as unknown as RunRecord;
}

function isPinnedPlan(value: unknown): value is WikiPinnedSourcePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.workspaceRoot === "string"
    && typeof raw.workspaceRealPath === "string"
    && typeof raw.configPath === "string"
    && typeof raw.fingerprint === "string"
    && typeof raw.defaultSourceIgnores === "boolean"
    && Array.isArray(raw.excludes) && raw.excludes.every((entry) => typeof entry === "string")
    && Array.isArray(raw.sources)
    && raw.sources.every((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return false;
      const entry = source as Record<string, unknown>;
      return typeof entry.scopeId === "string"
        && typeof entry.logicalPath === "string"
        && typeof entry.absolutePath === "string"
        && typeof entry.realPath === "string"
        && typeof entry.repositoryRoot === "string"
        && typeof entry.repositoryIdentity === "string"
        && typeof entry.head === "string"
        && typeof entry.dirtyFingerprint === "string"
        && isSourceOrigin(entry.origin);
    });
}

function isSourceOrigin(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.type === "link") return typeof raw.localPath === "string";
  return raw.type === "clone"
    && typeof raw.remoteUrl === "string"
    && (raw.ref === undefined || typeof raw.ref === "string");
}

function isExecutionReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return ["id", "boardTaskId", "partition", "agent", "task", "taskDigest"].every((key) => typeof raw[key] === "string")
    && (raw.status === "running" || raw.status === "complete" || raw.status === "failed" || raw.status === "interrupted")
    && isTimestamp(raw.startedAt)
    && (raw.completedAt === undefined || isTimestamp(raw.completedAt))
    && (raw.error === undefined || typeof raw.error === "string")
    && (raw.handoff === undefined || isArtifactRef(raw.handoff))
    && (raw.usage === undefined || isUsage(raw.usage));
}

function isReviewReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.executionId === "string"
    && (raw.verdict === "pass" || raw.verdict === "changes_requested")
    && typeof raw.candidateRevision === "string"
    && typeof raw.sourceFingerprint === "string"
    && isArtifactRef(raw.handoff)
    && isTimestamp(raw.completedAt);
}

function isCheckReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.candidateRevision === "string"
    && typeof raw.ok === "boolean"
    && isTimestamp(raw.completedAt)
    && Number.isInteger(raw.issueCount) && (raw.issueCount as number) >= 0
    && typeof raw.issueDigest === "string";
}

function isLeadAttempt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return isTimestamp(raw.completedAt) && isUsage(raw.usage);
}

function isArtifactRef(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.path === "string" && typeof raw.sha256 === "string";
}

function isUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (!["input", "output", "total"].every((key) => isNonNegativeNumber(raw[key]))) return false;
  return ["cacheRead", "cacheWrite", "cost", "compactions", "turns", "toolCalls", "contextTokens", "contextWindow", "contextPercent"]
    .every((key) => raw[key] === undefined || isNonNegativeNumber(raw[key]));
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRunStatus(value: unknown): value is WikiRunStatus {
  return value === "running" || value === "paused" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function blockingRunError(record: RunRecord): Error {
  return new Error(record.status === "paused"
    ? `Wiki run ${record.id} is paused; use /wiki resume`
    : `Wiki run ${record.id} is already running`);
}

function transitionLock(cwd: string): string {
  return path.join(cwd, ".okf-wiki", "run-transition.lock");
}

async function discardLegacyRuns(cwd: string): Promise<void> {
  await removePath(path.join(cwd, ".okf-wiki", "runs"), { recursive: true, force: true });
}

async function cleanupCurrentRun(cwd: string): Promise<void> {
  await removePath(runDir(cwd), { recursive: true, force: true });
}

async function reconcileRecoveredPublication(cwd: string): Promise<void> {
  let record: RunRecord | undefined;
  try { record = await readRecord(cwd); }
  catch { return; }
  if (!record || (record.status !== "running" && record.status !== "failed")) return;
  if (!record.finalizedRevision || record.review?.verdict !== "pass") return;
  if (record.review.candidateRevision !== record.finalizedRevision) return;
  if (await exists(record.candidateRoot)) return;
  const owner = await readRunOwner(cwd);
  if (owner && processIsAlive(owner.pid)) return;
  const wikiRoot = path.join(cwd, "wiki");
  if (!await exists(wikiRoot)) return;
  try {
    if ((await candidateRevision(wikiRoot)).digest === record.finalizedRevision) {
      await cleanupCurrentRun(cwd);
    }
  } catch {
    // Leave the failed-closed Run in place when the installed tree is unreadable.
  }
}

async function claimRunOwner(live: LiveRun): Promise<void> {
  const token = randomUUID();
  live.ownerToken = token;
  await writeText(ownerFile(live.record.cwd), `${JSON.stringify({
    version: 1,
    pid: process.pid,
    token,
    runId: live.record.id,
  })}\n`);
}

async function assertRunOwnerAvailable(live: LiveRun): Promise<void> {
  const owner = await readRunOwner(live.record.cwd);
  if (!owner || owner.token === live.ownerToken) return;
  if (processIsAlive(owner.pid)) {
    throw new Error(`Wiki run ${live.record.id} is owned by live process ${owner.pid}`);
  }
  await removePath(ownerFile(live.record.cwd), { force: true });
}

async function releaseRunOwner(live: LiveRun): Promise<void> {
  if (!live.ownerToken) return;
  const owner = await readRunOwner(live.record.cwd);
  if (owner?.token === live.ownerToken) await removePath(ownerFile(live.record.cwd), { force: true });
  live.ownerToken = undefined;
}

async function readRunOwner(cwd: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerFile(cwd), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!Number.isInteger(record.pid) || typeof record.token !== "string") return undefined;
    return { pid: record.pid as number, token: record.token };
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function ownerFile(cwd: string): string {
  return path.join(runDir(cwd), "owner.json");
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function leadPrompt(context: WikiLeadContext, checkpoint: string): Promise<string> {
  const body = await readFile(fileURLToPath(new URL("../../../prompts/lead.md", import.meta.url)), "utf8");
  const sources = context.plan.sources.map((source) => `- ${source.scopeId}: ${source.logicalPath}`).join("\n");
  const focus = context.focus ? `\nFocus: ${context.focus}\n` : "";
  const agents = "Available agents: survey, synthesize, write, review. Every assignment requires an existing in-progress boardTaskId and a stable partition. Survey and write may batch disjoint partitions; synthesize and review run alone.\n";
  const resume = context.resume
    ? "\nThis is a resumed Run. Reconcile the checkpoint and durable artifacts before doing more work. Do not restart completed partitions.\n"
    : "";
  return `${body}\n\n# This run\n\nLanguage: ${context.language}.${focus}${resume}${agents}\nPinned sources:\n${sources}\n\n${checkpoint}\n`;
}
