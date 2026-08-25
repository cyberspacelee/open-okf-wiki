import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { inspectWiki, pinsFromPlan, verifyPinnedSourcePlan, type WikiPinnedSourcePlan } from "./inspect.js";
import { reviewCandidatePages, taskDigest, verifyHandoff } from "./handoff.js";
import { ensureDirectory, exists, withExclusiveLock } from "./files.js";
import { errorMessage } from "./failures.js";
import { loadWikiWorkspace, resolveWorkspaceCatalogs, type ResolvedWikiWorkspace, type WikiWorkspaceWikiConfig } from "./workspace.js";
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
import { isImplicitPinPath } from "./path.js";
import { candidateTools, createTodoTool } from "./pi/tools.js";
import { runWikiSession, type RunWikiSessionOptions } from "./pi/session.js";
import { createSubagentRuntime, createSubagentTool, type SubagentTask, type SubagentTaskUpdate } from "./subagent.js";
import { createBoardStore, emptyBoard, replaceBoard, type WikiBoard, type WikiBoardStore } from "./board.js";
import { createOpenGaussCatalog } from "./opengauss.js";
import type { WikiCatalogRegistry } from "./catalog.js";
import {
  WikiRunResultError,
  type WikiAgentView,
  type WikiProducer,
  type WikiProducerResult,
  type WikiRunControl,
  type WikiRunHandle,
  type WikiRunView,
  type WikiSessionActivity,
} from "./producer-types.js";
import { candidateTargetRevision, candidateRevision, fileRevision, templatePackRevision } from "./revisions.js";
import { formatLeadCheckpoint, type CheckpointExecution, type CheckpointReview } from "./checkpoint.js";
import { installWikiPublication, recoverWikiPublication } from "./publication.js";
import { RunActivity } from "./run-activity.js";
import { toRunView } from "./run-view.js";
import {
  assertRunOwnerAvailable,
  claimRunOwner,
  cleanupCurrentRun,
  readRunRecord as readRecord,
  reconcileRecoveredRun as reconcileRecoveredPublication,
  releaseRunOwner,
  runDirectory as runDir,
  runTransitionLock as transitionLock,
  writeRunRecord as writeRecord,
  type RunExecutionReceipt,
  type RunRecord,
} from "./run-record.js";

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
  catalogs: WikiCatalogRegistry;
  templates: WikiTemplatePack;
  signal: AbortSignal;
  publish(): Promise<{ ok: boolean; message: string }>;
  check(): Promise<{ ok: boolean; message: string }>;
  note(id: string, agent: string, task: string, status: "running" | "complete" | "failed"): void;
  record(update: SubagentTaskUpdate): Promise<void>;
  observe(event: WikiSessionActivity): void;
  assertDispatch(tasks: readonly SubagentTask[]): void;
}

const active = new Map<string, LiveRun>();

interface LiveRun {
  record: RunRecord;
  plan: WikiPinnedSourcePlan;
  done: Promise<void>;
  result?: WikiProducerResult;
  board?: WikiBoard;
  candidateRevision?: { digest: string; files: string[] };
  checkpointText?: string;
  activity: RunActivity;
  listeners: Set<(view: WikiRunView) => void>;
  activation?: {
    controller: AbortController;
    ownerToken: string;
    recordUpdates: Promise<void>;
    templates?: WikiTemplatePack;
    catalogs?: ReadonlySet<string>;
  };
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
          schemaVersion: 1,
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
        const live: LiveRun = emptyLive(record, plan, new RunActivity(runDir(record.cwd)));
        const ownerToken = await claimRunOwner(live.record);
        active.set(key, live);
        startLive(live, workspace, options, { resume: false, focus: request.focus }, ownerToken);
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
      const activity = await RunActivity.open(runDir(record.cwd));
      return handleFor(emptyLive(record, record.plan, activity), options, workspace);
    },
  };
}

function startLive(
  live: LiveRun,
  workspace: ResolvedWikiWorkspace,
  options: WikiProducerOptions,
  flags: { resume: boolean; focus?: string },
  ownerToken: string,
): void {
  const record = live.record;
  const plan = live.plan;
  const controller = new AbortController();
  const activation = { controller, ownerToken, recordUpdates: Promise.resolve() } as NonNullable<LiveRun["activation"]>;
  live.activation = activation;
  live.result = undefined;
  live.activity.noteAgent("lead", "lead", undefined, "running");
  live.done = (async () => {
    try {
      const initial = emptyBoard(record.focus ?? "Generate a complete repository Wiki");
      const stored = createBoardStore(runDir(record.cwd), initial);
      const board = watchBoard(stored, live);
      if (!flags.resume) await board.write(initial);
      else live.board = await board.read();
      const catalogs = new Map([...await resolveWorkspaceCatalogs(plan.catalogs, plan.workspaceRoot)]
        .map(([name, config]) => [name, createOpenGaussCatalog(config)]));
      activation.catalogs = new Set(catalogs.keys());
      const templates = await resolveWikiTemplatePack(
        workspace.root,
        workspace.wiki.templates,
        record.language ?? workspace.language,
      );
      activation.templates = templates;
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
        catalogs,
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
          const transition = activation.recordUpdates.then(async () => await recordAgent(live, board, update));
          activation.recordUpdates = transition.catch(() => undefined);
          await transition;
        },
        observe(event) {
          observeActivity(live, event);
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
      try {
        await live.activity.flush();
      } catch (error) {
        if (record.status !== "succeeded" && record.status !== "cancelled") {
          record.status = "failed";
          record.error = `Run activity persistence failed: ${errorMessage(error)}`;
          record.updatedAt = new Date().toISOString();
          await writeRecord(record);
          emit(live);
        }
      }
      await releaseRunOwner(record.cwd, activation.ownerToken);
      if (record.status === "succeeded" || record.status === "cancelled") {
        await cleanupCurrentRun(record.cwd);
      }
      if (record.status !== "running" && record.status !== "paused") {
        const key = runKey(record.cwd);
        if (active.get(key) === live) active.delete(key);
      }
      if (live.activation === activation) live.activation = undefined;
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
      context.catalogs,
      {
        maxConcurrency: config.maxConcurrentAgents - 1,
        maxWorkerRepairRounds: config.maxWorkerRepairRounds,
        templates: context.templates,
        language: context.language,
        assertDispatch: context.assertDispatch,
        handoffsForTask: (task) => requiredHandoffs(live, task),
      },
    );
    const tools: ToolDefinition<any, any, any>[] = [
      ...candidateTools(writeGuardFromPlan(context.plan, context.candidateRoot), LEAD_CANDIDATE_TOOLS),
      createTodoTool(context.board),
      createSubagentTool(runtime),
      createCandidateCheckTool(() => context.check()),
      createPublishTool(() => context.publish()),
    ];
    const prompt = await leadPrompt(
      context,
      checkpointFor(live),
      Boolean(record.sessionFile && await exists(record.sessionFile)),
    );
    const systemPrompt = await readFile(fileURLToPath(new URL("../../../prompts/lead.md", import.meta.url)), "utf8");
    const result = await runWikiSession(context.plan.workspaceRoot, tools, prompt, context.signal, {
      ...session,
      systemPrompt,
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
  const templates = live.activation?.templates;
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
  const activation = live.activation;
  if (!activation?.templates) return undefined;
  const validation = await validateWikiTree(live.record.candidateRoot, pinsFromPlan(live.plan), activation.templates, {
    catalogs: activation.catalogs,
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
  const surveys = surveyExecutions(live);
  const missing = live.plan.sources
    .filter((_source, index) => (
      surveys[index]?.status !== "complete" || !surveys[index]?.handoff || !surveys[index]?.completedAt
    ))
    .map((source) => source.scopeId);
  const synthesis = latestExecution(live, "synthesize", "workspace-analysis");
  const agents = incoming ? new Set(incoming.map((task) => task.agent)) : undefined;
  if (agents?.has("survey")) return undefined;
  if (agents?.has("synthesize") || !agents) {
    if (missing.length) return `Cross-Source analysis requires completed surveys for: ${missing.join(", ")}`;
  }
  if (agents?.has("synthesize")) return undefined;
  if (synthesis?.status !== "complete" || !synthesis.handoff || !synthesis.completedAt) {
    return "Multi-Source Workspace requires one completed synthesize execution for partition workspace-analysis";
  }
  if (agents?.has("write")) return undefined;
  const lastSurvey = surveys.reduce((latestAt, entry) => {
    const completedAt = entry?.completedAt ?? "";
    return completedAt > latestAt ? completedAt : latestAt;
  }, "");
  if (synthesis.startedAt < lastSurvey) {
    return "Cross-Source synthesis must start after every Source survey completes";
  }
  const earlyWrite = live.record.executions.find((entry) => entry.agent === "write" && entry.startedAt < (synthesis.completedAt ?? ""));
  if (earlyWrite) return `Write target ${earlyWrite.partition} started before cross-Source synthesis completed`;
  return undefined;
}

function latestExecution(live: LiveRun, agent: string, partition: string): RunExecutionReceipt | undefined {
  return live.record.executions
    .filter((entry) => entry.agent === agent && entry.partition === partition)
    .reduce<RunExecutionReceipt | undefined>((current, entry) => (
      !current || entry.startedAt >= current.startedAt ? entry : current
    ), undefined);
}

function surveyExecutions(live: LiveRun): Array<RunExecutionReceipt | undefined> {
  return live.plan.sources.map((source) => latestExecution(live, "survey", source.scopeId));
}

function requiredHandoffs(live: LiveRun, task: SubagentTask): string[] {
  const completed = latestArtifacts(live.record.executions)
    .filter((entry) => entry.status === "complete" && entry.handoff);
  if (task.agent === "synthesize") {
    return completed.filter((entry) => entry.agent === "survey").map((entry) => entry.handoff!.path);
  }
  if (task.agent === "review") {
    return completed.filter((entry) => entry.agent === "survey" || entry.agent === "synthesize" || entry.agent === "write")
      .map((entry) => entry.handoff!.path);
  }
  if (task.agent !== "write") return [];
  const implicit = live.plan.sources.length === 1 && isImplicitPinPath(live.plan.sources[0]?.logicalPath ?? "");
  const owner = implicit
    ? live.plan.sources[0]?.scopeId
    : task.partition === "wiki-root" ? undefined : task.partition.split("/")[0];
  const relevant = completed.filter((entry) => (
    entry.agent === "synthesize"
    || (entry.agent === "survey" && (owner === undefined || entry.partition === owner))
  )).map((entry) => entry.handoff!.path);
  if (live.record.review?.verdict === "changes_requested") relevant.push(live.record.review.handoff.path);
  return [...new Set(relevant)];
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
      ...(update.writeMode ? { writeMode: update.writeMode } : {}),
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
    let verified;
    try {
      verified = update.handoff
        ? await verifyReceiptHandoff(live, receipt, update.handoff)
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
  const currentReceipts = new Set(latestArtifacts(live.record.executions).map((receipt) => receipt.id));
  for (const receipt of live.record.executions) {
    if (receipt.status === "running") {
      if (await adoptCompletedHandoff(live, receipt)) {
        changed = true;
        continue;
      }
      receipt.status = "interrupted";
      receipt.completedAt = new Date().toISOString();
      receipt.error = "Execution was interrupted before a terminal receipt was persisted";
      live.activity.noteAgent(receipt.id, receipt.agent, receipt.task, "failed");
      changed = true;
    }
    if (receipt.status === "complete" && !receipt.handoff) {
      invalidateReceipt(live, receipt, "Completed execution has no attested handoff");
      changed = true;
    } else if (receipt.status === "complete" && receipt.handoff) {
      try {
        const valid = currentReceipts.has(receipt.id)
          ? (await verifyReceiptHandoff(live, receipt, receipt.handoff.path))?.sha256 === receipt.handoff.sha256
          : await fileRevision(artifactLocation(live, receipt.handoff.path)) === receipt.handoff.sha256;
        if (!valid) {
          invalidateReceipt(live, receipt, "Handoff content or output contract no longer matches its receipt");
          changed = true;
        }
      } catch {
        invalidateReceipt(live, receipt, "Handoff referenced by the receipt is missing or invalid");
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
  let verified;
  try {
    verified = await verifyReceiptHandoff(live, receipt, relative);
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

async function verifyReceiptHandoff(live: LiveRun, receipt: RunExecutionReceipt, relative: string) {
  const completedRevision = receipt.agent === "write"
    ? await candidateTargetRevision(live.record.candidateRoot, writeTarget(receipt))
    : live.candidateRevision;
  return await verifyHandoff(artifactLocation(live, relative), {
    executionId: receipt.id,
    boardTaskId: receipt.boardTaskId,
    partition: receipt.partition,
    writeMode: receipt.writeMode,
    agent: receipt.agent,
    taskDigest: receipt.taskDigest,
    candidateRevision: completedRevision?.digest,
    ...(receipt.agent === "review" && completedRevision ? { candidatePages: reviewCandidatePages(completedRevision.files) } : {}),
  });
}

function invalidateReceipt(live: LiveRun, receipt: RunExecutionReceipt, error: string): void {
  receipt.status = "failed";
  receipt.error = error;
  if (live.record.review?.executionId === receipt.id) live.record.review = undefined;
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
    const key = `${execution.boardTaskId}\0${execution.writeMode ?? "partition"}\0${execution.partition}`;
    const current = latest.get(key);
    if (!current || execution.startedAt >= current.startedAt) latest.set(key, execution);
  }
  return [...latest.values()];
}

function latestArtifacts(executions: readonly RunExecutionReceipt[]): RunExecutionReceipt[] {
  const latest = new Map<string, RunExecutionReceipt>();
  for (const execution of executions) {
    const key = `${execution.agent}\0${execution.writeMode ?? "partition"}\0${execution.partition}`;
    const current = latest.get(key);
    if (!current || execution.startedAt >= current.startedAt) latest.set(key, execution);
  }
  return [...latest.values()];
}

function writeTarget(execution: Pick<RunExecutionReceipt, "partition" | "writeMode">) {
  if (execution.writeMode !== "subtree" && execution.writeMode !== "directory") {
    throw new Error(`Write execution ${execution.partition} has no writeMode`);
  }
  return { path: execution.partition, mode: execution.writeMode } as const;
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
    ...(entry.writeMode ? { writeMode: entry.writeMode } : {}),
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
      const runnerOwnsCleanup = live.activation !== undefined;
      await withExclusiveLock(transitionLock(workspace.root), async () => {
        await assertRunOwnerAvailable(live.record.cwd, live.record.id, live.activation?.ownerToken);
        if (action === "pause") {
          if (live.record.status !== "running") throw new Error(`Cannot pause a ${live.record.status} Wiki run`);
          live.record.status = "paused";
          live.activation?.controller.abort();
        } else if (action === "cancel") {
          if (live.record.status !== "running" && live.record.status !== "paused" && live.record.status !== "failed") {
            throw new Error(`Cannot cancel a ${live.record.status} Wiki run`);
          }
          live.record.status = "cancelled";
          live.activation?.controller.abort();
          settleLead(live, "failed");
        }
        live.record.updatedAt = new Date().toISOString();
        await writeRecord(live.record);
        emit(live);
      });
      if (action === "cancel") {
        if (runnerOwnsCleanup) await live.done;
        else {
          await live.activity.flush().catch(() => {});
          await cleanupCurrentRun(workspace.root);
        }
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
    await assertRunOwnerAvailable(live.record.cwd, live.record.id, live.activation?.ownerToken);
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
    const ownerToken = await claimRunOwner(live.record);
    active.set(key, live);
    startLive(live, workspace, options, { resume: true, focus: live.record.focus }, ownerToken);
  });
}

async function toView(live: LiveRun): Promise<WikiRunView> {
  return toRunView(live.record, live.board ?? await createBoardStore(runDir(live.record.cwd)).read(), live.activity.agents());
}

function emptyLive(record: RunRecord, plan: WikiPinnedSourcePlan, activity: RunActivity): LiveRun {
  return {
    record,
    plan,
    done: Promise.resolve(),
    activity,
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
  live.activity.noteAgent(id, agent, task, status);
  live.record.updatedAt = new Date().toISOString();
  emit(live);
}

function observeActivity(live: LiveRun, event: WikiSessionActivity): void {
  live.activity.observe(event);
  live.record.updatedAt = new Date().toISOString();
  emit(live);
}

function settleLead(live: LiveRun, status: WikiAgentView["status"]): void {
  live.activity.noteAgent("lead", "lead", undefined, status);
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

function blockingRunError(record: RunRecord): Error {
  return new Error(record.status === "paused"
    ? `Wiki run ${record.id} is paused; use /wiki resume`
    : `Wiki run ${record.id} is already running`);
}

async function leadPrompt(context: WikiLeadContext, checkpoint: string, resumedSession: boolean): Promise<string> {
  if (resumedSession) {
    return `Resume the existing Wiki Lead session from the current durable state. Do not repeat completed work.\n\n${checkpoint}\n`;
  }
  const sources = context.plan.sources.map((source) => `- ${source.scopeId}: ${source.logicalPath}`).join("\n");
  const focus = context.focus ? `\nFocus: ${context.focus}\n` : "";
  const agents = "Available agents: survey, synthesize, write, review. Every assignment requires an existing in-progress boardTaskId and a stable partition; write also requires writeMode. Survey and disjoint Domain writes may batch; synthesize and review run alone.\n";
  const resume = context.resume
    ? "\nThis is a resumed Run. Reconcile the checkpoint and durable artifacts before doing more work. Do not restart completed partitions.\n"
    : "";
  return `# This run\n\nLanguage: ${context.language}.${focus}${resume}${agents}\nPinned sources:\n${sources}\n\n${checkpoint}\n`;
}
