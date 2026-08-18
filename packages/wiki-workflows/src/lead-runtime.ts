import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import YAML from "yaml";
import {
  readWikiWorkflowFile,
  workflowTools,
  writeWikiWorkflowFile,
  type WikiPageWriter,
  type WikiWorkflowFileSlot,
} from "./agent-tools.js";
import { createWikiArtifactStore } from "./artifact-store.js";
import {
  boundedDelegateSummary,
  projectWikiLeadSnapshot,
  WikiTaskExecutionError,
  WikiTaskPauseError,
  type WikiDelegateContract,
  type WikiResearchSignal,
} from "./delegate-contracts.js";
import { inspectEvidenceHandoff, type EvidenceLedgerCitation } from "./evidence-ledger.js";
import { inside } from "./files.js";
import { WikiRejectedError } from "./wiki-reject.js";
import { decodeUtf8Fatal, inspectResearchHandoff, inspectReviewHandoff, summarizeWikiMarkdown } from "./wiki-work-files.js";
import type { WikiAgentSnapshot, WikiAgentTelemetry, WikiContextStats } from "./producer-types.js";
import type { WikiLeadObservation, WikiLeadRuntime, WikiPinnedSourcePlan } from "./runtime-types.js";
import type { WikiExecutionBudgets } from "./producer-types.js";
import { PiSessionObserver, readSessionUsage, type PiSessionObserverOptions } from "./pi-session-observer.js";
import { WikiTaskRuntime, WikiWritePathLease, type WikiLeafAgent, type WikiLeafResult, type WikiLeafTaskContext, type WikiTaskProgressEvent } from "./task-runtime.js";
import {
  createWikiDelegateCancelTool,
  createWikiDelegateCollectTool,
  createWikiDelegateStartTool,
  createWikiFinishTool,
  createWikiPlanTool,
  createWikiTaxonomyTool,
  derivedIndexPaths,
  mergeTaxonomyDecisions,
  parseWikiSpec,
  wikiLeadMayWrite,
  WikiLeadRun,
  type WikiBoardTaxonomyDecision,
  type WikiDelegateCancelReasonCode,
  type WikiSpec,
} from "./lead.js";
import type { WikiAgentOutcome } from "./producer-types.js";
import { wikiToolRejected } from "./wiki-tool-error.js";
import type { WikiReviewResult } from "./delegate-contracts.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WikiAgentRole, WikiGenerationProfile } from "./workspace.js";
import { WikiBudgetExhaustedError } from "./failures.js";
import { decideWikiAgentAttempt } from "./agent-attempt-policy.js";
import { pinnedWorkspaceToolPolicy } from "./path-policy.js";

const PI_SESSION_REQUEST_RETRIES = 0;
const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60_000;
const MAX_SESSION_TIMEOUT_MS = 2_147_483_647;

export interface PiWikiLeadAgentOptions {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  language?: "zh" | "en";
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
  /** Thinking-time deadline for Lead; wall-clock deadline for each delegated Pi session. Default 20 minutes. */
  sessionTimeoutMs?: number;
  /** Materialized production skill root inside the workspace. */
  skillRoot?: string;
  /** Run-scoped persistent Pi session directory. */
  sessionDir?: string;
  /** Exact Pi session file to reopen. */
  sessionFile?: string;
  budgets?: WikiExecutionBudgets;
  skillPath?: string;
  sourcePlan?: WikiPinnedSourcePlan;
}

export interface CreatePiLeadRuntimeOptions extends Omit<PiWikiLeadAgentOptions, "sessionDir" | "sessionFile" | "skillPath"> {
  leadBudgets?: Pick<WikiExecutionBudgets, "maxTurnsPerSession" | "maxToolCallsPerSession">;
  concurrency?: number;
  transientRetries?: number;
  baseRetryDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  models?: PiWikiRoleModels;
  runSessionDirectory?: string;
  leadSessionFile?: string;
  leadSessionAttempt?: number;
}

export interface PiWikiRoleModel {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

export type PiWikiRoleModels = Record<WikiAgentRole, PiWikiRoleModel>;

/** Complete reusable production Adapter for WikiProducer's model-facing seam. */
export function createPiLeadRuntime(options: CreatePiLeadRuntimeOptions = {}): WikiLeadRuntime {
  const transientRetries = options.transientRetries ?? 1;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  if (!Number.isInteger(transientRetries) || transientRetries < 0) throw new Error("transientRetries must be a non-negative integer");
  if (!Number.isFinite(baseRetryDelayMs) || baseRetryDelayMs < 0) throw new Error("baseRetryDelayMs must be non-negative");
  const sessionTimeoutMs = validatedSessionTimeoutMs(options.sessionTimeoutMs);
  const leadModel = options.models?.lead ?? { model: options.model, thinkingLevel: options.thinkingLevel };
  const sessionOptions = {
    model: leadModel.model,
    thinkingLevel: leadModel.thinkingLevel,
    createSession: options.createSession,
    sessionTimeoutMs,
    language: options.language,
    budgets: options.budgets,
  };
  return {
    async run(request) {
      return await runLeadSession(request, options, sessionOptions, (observation) => request.record(observation));
    },
  };
}

async function runLeadSession(
  request: Parameters<WikiLeadRuntime["run"]>[0],
  options: CreatePiLeadRuntimeOptions,
  sessionOptions: PiWikiLeadAgentOptions,
  observe: (observation: WikiLeadObservation) => void | Promise<void>,
): Promise<Awaited<ReturnType<WikiLeadRuntime["run"]>>> {
      const transientRetries = options.transientRetries ?? 1;
      const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
      const leadRun = await WikiLeadRun.open({
        workspace: request.sourcePlan.workspaceRoot,
        runId: request.runId,
        candidateWikiRoot: request.candidateWikiRoot,
        policy: request.generation,
        requiredSections: request.generation.templates.requiredSections,
        sourcePlan: request.sourcePlan,
        language: request.language,
        assertActive: request.assertActive,
        executionToken: request.executionToken,
        commitLead: request.commitLead,
        readLead: request.readLead,
        maxDelegatedTasks: (request.budgets ?? options.budgets)?.maxDelegatedTasks,
      });
      let specRecord = leadRun.specRecord;
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) controller.abort(request.signal.reason);
      const writeLease = new WikiWritePathLease();
      const generation = request.generation;
      const requiredReviewCoverage = generation.review.mustCover;
      const pageWriter: WikiPageWriter = {
        async replacePage(input) {
          const release = input.actor === "lead" ? await writeLease.acquire([input.path], controller.signal) : undefined;
          try { await leadRun.replacePage(input); }
          finally { release?.(); }
        },
      };
      const artifactStore = createWikiArtifactStore({ workspace: request.sourcePlan.workspaceRoot });
      const sourceScopes = request.sourcePlan.sources.map((source) => source.scopeId);
      const budgets = request.budgets ?? options.budgets;
      const roleModels = options.models;
      const runSessionDirectory = request.runSessionDirectory ?? options.runSessionDirectory;
      const batchTasks = new Map<number, Map<string, WikiAgentSnapshot>>();
      let leadSession: AgentSession | undefined;
      const snapshotNow = () => new Date((options.now ?? Date.now)()).toISOString();
      const onTask = async (event: WikiTaskProgressEvent): Promise<void> => {
        let projection = batchTasks.get(event.batchId);
        if (!projection) {
          projection = new Map();
          batchTasks.set(event.batchId, projection);
        }
        const taskId = event.task.id;
        const target = { kind: "task" as const, batch: event.batchId, taskId };
        if (event.phase === "queued") {
          projection.set(taskId, {
            target, role: event.task.role, status: "queued", attempt: 1,
            activity: "starting", activeTools: [], health: "healthy",
          });
          const tasks = [...projection.values()];
          await observe({ kind: "batch", phase: "queued", batch: event.batchId, tasks });
          return;
        }
        const current = projection.get(taskId) ?? {
          target, role: event.task.role, status: "queued" as const, attempt: 1,
          activity: "starting" as const, activeTools: [], health: "healthy" as const,
        };
        if (event.phase === "start") {
          current.status = "running";
          current.startedAt = snapshotNow();
          current.updatedAt = current.startedAt;
          if (current.activity === "starting") current.activity = "waiting_model";
          applyTelemetry(current, event.telemetry);
          projection.set(taskId, current);
          await observe({ kind: "batch", phase: "started", batch: event.batchId, tasks: [...projection.values()], taskId });
          return;
        }
        if (event.phase === "update" && event.telemetry) {
          applyTelemetry(current, event.telemetry);
          projection.set(taskId, current);
          await observe({ kind: "telemetry", target: event.telemetry.target, telemetry: event.telemetry });
          return;
        }
        current.status = event.receipt?.status ?? "failed";
        current.summary = event.receipt?.summary;
        if (event.receipt?.attempts !== undefined) current.attempt = event.receipt.attempts;
        current.updatedAt = snapshotNow();
        current.activity = "settled";
        if (event.usage) current.usage = event.usage;
        applyTelemetry(current, event.telemetry);
        projection.set(taskId, current);
        if (event.receipt) {
          const settled = [...projection.values()];
          if (settled.length > 0 && settled.every((task) => ["complete", "incomplete", "failed"].includes(task.status))) {
            await leadSession?.followUp(`Wave ${event.batchId} settled. Re-read .okf-wiki/current/board.md before the next transition.`);
          }
        }
        await observe({ kind: "batch", phase: "completed", batch: event.batchId, tasks: [...projection.values()], taskId });
      };
      const tasks = new WikiTaskRuntime({
        runId: request.runId,
        sourceScopes,
        candidateWikiRoot: request.candidateWikiRoot,
        artifactStore,
        agent: new PiWikiLeafAgent({
          ...sessionOptions,
          skillRoot: request.skillRoot,
          sessionDir: runSessionDirectory,
          budgets,
          sourcePlan: request.sourcePlan,
        }, pageWriter, generation, () => specRecord?.spec, roleModels),
        concurrency: options.concurrency,
        maxDelegatedTasks: budgets?.maxDelegatedTasks,
        maxDelegateBatches: budgets?.maxDelegateBatches,
        restoredState: leadRun.taskRuntimeState,
        transitions: leadRun.taskTransitions,
        writeLease,
        transientRetries,
        baseRetryDelayMs,
        sleep: options.sleep,
        random: options.random,
        now: options.now,
        onTask,
        reportObservability: async (input) => await observe({ kind: "health", ...input }),
      });
      const policy = pinnedWorkspaceToolPolicy(request.sourcePlan, request.candidateWikiRoot, request.skillRoot, runBoardPath(request.runId));
      const leadFileSlots = createLeadFileSlots(
        policy.workspaceRoot,
        request.runId,
        request.sourcePlan.sources.length,
      );
      await ensureLeadFileDrafts(policy.workspaceRoot, leadFileSlots, request.sourcePlan.sources.map((source) => source.scopeId));
      await tasks.resume(controller.signal);
      let finishSummary: string | undefined;
      let pause: WikiTaskPauseError | undefined;
      const startCurrent = async () => {
        const firstWave = leadRun.taskRuntimeState.batches.length === 0;
        const discoveryPlan = firstWave
          ? structuredClone(await readDiscoveryPlan(
            policy.workspaceRoot,
            leadFileSlots,
            request.sourcePlan.sources.map((source) => source.scopeId),
          ))
          : [];
        const queued = await leadRun.startNextReadyWave(discoveryPlan);
        try {
          if (queued.wave === "review") writeLease.assertReviewAllowed();
          const started = await tasks.start(queued.contracts, controller.signal);
          if (started.batchId !== queued.batchId) {
            throw new Error(`TaskRuntime started batch ${started.batchId}, expected queued batch ${queued.batchId}`);
          }
          return { wave: queued.wave, batchId: started.batchId };
        } catch (error) {
          await leadRun.rollbackDelegateBatch(queued.batchId);
          throw error;
        }
      };
      const requireActiveWave = async (operation: "collect" | "cancel") => {
        const active = await leadRun.currentActiveWave();
        if (!active) throw new Error(`No active Wiki wave to ${operation}`);
        return active;
      };
      const presentBatch = async (snapshot: Awaited<ReturnType<WikiTaskRuntime["collect"]>>) => {
        const presented = projectWikiLeadSnapshot(await leadRun.presentSnapshot(snapshot));
        await prefillTaxonomyDraft(leadRun, policy.workspaceRoot, leadFileSlots, presented);
        return presented;
      };
      const thinkingClock = createThinkingClock(sessionOptions.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS);
      const collectCurrent = async (collectOptions: { until: "any" | "all"; timeoutSeconds?: number }) => {
        const active = await requireActiveWave("collect");
        thinkingClock.pause();
        try {
          return await presentBatch(await tasks.collect(active.batchId, collectOptions, controller.signal));
        } catch (error) {
          if (error instanceof WikiTaskPauseError) {
            pause = error;
            controller.abort(error);
          }
          throw error;
        } finally {
          thinkingClock.resume();
        }
      };
      const cancelCurrent = async (reasonCode?: WikiDelegateCancelReasonCode) => {
        const active = await requireActiveWave("cancel");
        return await presentBatch(await tasks.cancel(active.batchId, undefined, reasonCode));
      };
      const leadTools = withExecutionModes([
        ...workflowTools(policy, "lead", undefined, request.sourcePlan.sources.map((source) => source.scopeId), undefined, pageWriter, undefined, leadFileSlots),
        createWikiTaxonomyTool(async () => withBoard(
          leadRun.compactionObserved,
          await leadRun.saveTaxonomy(await readYamlWorkflowFile(policy.workspaceRoot, leadSlot(leadFileSlots, ".okf-wiki/current/taxonomy.yaml"))),
        )),
        createWikiPlanTool(async () => {
          const input = await readYamlWorkflowFile(policy.workspaceRoot, leadSlot(leadFileSlots, ".okf-wiki/current/wiki-spec.yaml"));
          const spec = parseWikiSpec(input);
          specRecord = await leadRun.saveSpec(spec, specRecord?.revision ?? 0);
          return withBoard(leadRun.compactionObserved, {
            revision: specRecord.revision,
            pages: spec.pages,
            directWriteAllowed: wikiLeadMayWrite(spec, leadRun.compactionObserved),
          });
        }),
        createWikiDelegateStartTool(async () => {
          try {
            return withBoard(leadRun.compactionObserved, await startCurrent());
          } catch (error) {
            rejectWikiTool("wiki_delegate_start", error);
          }
        }),
        createWikiDelegateCollectTool(async (collectOptions) => withBoard(
          leadRun.compactionObserved,
          await collectCurrent(collectOptions),
        )),
        createWikiDelegateCancelTool(async (reasonCode) => withBoard(
          leadRun.compactionObserved,
          await cancelCurrent(reasonCode),
        )),
        createWikiFinishTool(async () => {
          if (finishSummary) throw new Error("wiki_finish may be accepted only once");
          const summary = workflowCompletionSummary(decodeUtf8Fatal(await readWikiWorkflowFile(
            policy.workspaceRoot,
            leadSlot(leadFileSlots, ".okf-wiki/current/completion.md"),
          )));
          const defects: string[] = [];
          if (!summary.trim()) defects.push("wiki_finish requires a summary");
          if (!specRecord) defects.push("wiki_finish requires an accepted WikiSpec");
          try {
            tasks.assertFinishable();
          } catch (error) {
            if (error instanceof WikiTaskPauseError) {
              pause = error;
              controller.abort(error);
              throw error;
            }
            if (error instanceof WikiRejectedError) defects.push(...error.defects);
            else throw error;
          }
          if (defects.length) throw new WikiRejectedError(defects);
          await leadRun.finish(undefined, requiredReviewCoverage);
          finishSummary = boundedDelegateSummary(summary);
          return withBoard(leadRun.compactionObserved, { accepted: true });
        }),
      ]);
      await observe({ kind: "progress", message: "Wiki Lead is deciding adaptive research and writing tasks" });
      try {
        const maxAttempts = transientRetries + 1;
        const attemptBase = Math.max(request.attempt, request.leadSessionAttempt ?? options.leadSessionAttempt ?? request.attempt);
        for (let retryIndex = 0; retryIndex < maxAttempts; retryIndex += 1) {
          const attempt = attemptBase + retryIndex;
          if (retryIndex > 0) finishSummary = undefined;
          try {
            const leadSessionDir = runSessionDirectory ? path.join(runSessionDirectory, "lead") : undefined;
            const resumeFile = retryIndex === 0
              ? request.leadSessionFile ?? options.leadSessionFile
              : undefined;
            await runPiSession(policy.workspaceRoot, leadTools, leadSessionPrompt(request.prompt, request.sourcePlan.sources.length), controller.signal, {
              ...sessionOptions,
              sessionDir: leadSessionDir,
              sessionFile: resumeFile,
              skillRoot: request.skillRoot,
              skillPath: request.skillRoot,
              budgets: sessionBudgets(budgets, options.leadBudgets),
            }, async (telemetry) => {
              if (telemetry.activity === "compacting") await leadRun.observeCompaction();
              await observe({ kind: "telemetry", target: telemetry.target, telemetry });
            }, {
              target: { kind: "lead" },
              attempt,
              now: options.now,
              onHealth: async (input) => await observe({ kind: "health", ...input }),
              thinkingClock,
            },
            (session) => { leadSession = session; });
            break;
          } catch (error) {
            if (pause) break;
            const decision = decideWikiAgentAttempt({
              error,
              attempt: retryIndex + 1,
              maxAttempts,
              aborted: request.signal.aborted,
              baseRetryDelayMs,
              random: options.random,
            });
            const failure = decision.failure;
            if (decision.action === "pause") {
              const reason = failure.code === "usage_limit" ? "usage_limit" : "quota";
              pause = new WikiTaskPauseError(reason, failure.message, failure.retryAfterMs);
              controller.abort(pause);
              break;
            }
            if (decision.action !== "retry") throw error;
            const delay = decision.delayMs;
            const sampledAt = snapshotNow();
            const retryTelemetry: WikiAgentTelemetry = {
              target: { kind: "lead" },
              attempt,
              sampledAt,
              activity: "retry_wait",
              activeTools: [],
              lastActivityAt: sampledAt,
              lastHeartbeatAt: sampledAt,
              process: [{
                sequence: attempt,
                at: sampledAt,
                kind: "retry",
                severity: "warning",
                target: { kind: "lead" },
                message: `Fresh Pi session retry scheduled in ${delay}ms`,
                completed: false,
              }],
            };
            await observe({ kind: "telemetry", target: retryTelemetry.target, telemetry: retryTelemetry });
            await (options.sleep ?? retrySleep)(delay, controller.signal);
          }
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
      }
      if (pause) {
        const retryAt = pause.retryAfterMs === undefined
          ? undefined
          : new Date((options.now ?? Date.now)() + pause.retryAfterMs).toISOString();
        await observe({ kind: "progress", message: "Wiki Lead paused by provider" });
        return { kind: "pause", reason: pause.reason, summary: pause.message, retryAt };
      }
      if (!finishSummary) throw new Error("Lead agent completed without wiki_finish");
      await observe({ kind: "progress", message: "Wiki Lead finished" });
      return { kind: "complete", summary: finishSummary };
}

/** Pi Adapter for one delegated leaf; TaskRuntime owns retries and artifact acceptance. */
export class PiWikiLeafAgent implements WikiLeafAgent {
  constructor(
    private readonly options: PiWikiLeadAgentOptions = {},
    private readonly pageWriter?: WikiPageWriter,
    private readonly generation?: WikiGenerationProfile,
    private readonly currentSpec?: () => WikiSpec | undefined,
    private readonly roleModels?: PiWikiRoleModels,
  ) {
    validatedSessionTimeoutMs(options.sessionTimeoutMs);
  }

  async run(task: WikiDelegateContract, context: WikiLeafTaskContext): Promise<WikiLeafResult> {
    if (!this.options.sourcePlan) throw new Error("Pinned source plan is required for Wiki leaf execution");
    const fileLines = evidenceFileLines(this.options.sourcePlan);
    const policy = pinnedWorkspaceToolPolicy(this.options.sourcePlan, context.candidateWikiRoot, this.options.skillRoot);
    const artifactHandoffs = Object.entries(context.contextArtifacts).map(([id, ref]) => {
      const file = path.resolve(policy.workspaceRoot, ref.relativePath);
      policy.sourceRoots.set(ref.relativePath, { logicalRoot: file, physicalRoot: file });
      return { id, path: ref.relativePath, sha256: ref.sha256, sizeBytes: ref.sizeBytes };
    });
    const artifactRelativePaths = artifactHandoffs.map((handoff) => handoff.path);
    const declaredSources = [...task.sourceScopeIds, ...artifactRelativePaths];
    const role = task.role === "write" ? "writer" : task.role === "review" ? "reviewer" : "researcher";
    let review: WikiReviewResult | undefined;
    let researchSignal: WikiResearchSignal | undefined;
    let writeFinished = false;
    let markdownSnapshot: string | undefined;
    if (this.options.skillRoot) roleSkill(this.options.skillRoot, role);
    const taskFileSlots = createTaskFileSlots(policy.workspaceRoot, context, task, role);
    const spec = this.currentSpec?.();
    const reviewIndexes = task.role === "review" && spec
      ? derivedIndexPaths(spec.pages).map(addWikiPrefix)
      : [];
    await writeWikiWorkflowFile(
      policy.workspaceRoot,
      taskFileSlots.brief,
      taskFileBrief(task, artifactHandoffs, reviewIndexes, this.options.language),
    );
    const tools = withExecutionModes([
      ...workflowTools(policy, role, task.writePaths, declaredSources, task.reviewPaths, this.pageWriter, reviewIndexes, taskFileSlots.slots),
      ...(role === "reviewer" ? [leafFinishTool({
        name: "wiki_review_finish",
        label: "Finish Wiki review",
        description: "Finish after writing the complete review to .okf-wiki/task/review.md.",
        promptSnippet: "Finish the file-based Wiki review",
        field: "verdict",
        allowed: ["pass", "changes_requested"],
        finish: async (verdict) => {
          if (review) throw new Error("wiki_review_finish may be accepted only once");
          const bytes = await readWikiWorkflowFile(policy.workspaceRoot, taskFileSlots.output);
          const markdown = Buffer.from(bytes).toString("utf8");
          const parsed = inspectReviewHandoff(bytes, verdict as "pass" | "changes_requested", task.reviewPaths ?? []);
          const evidence = parsed.structural ? { defects: [] as string[] } : inspectEvidenceHandoff({ markdown, contract: task, fileLines });
          rejectHandoffDefects([...parsed.defects, ...evidence.defects]);
          markdownSnapshot = markdown;
          review = parsed.result!;
        },
      })] : []),
      ...(role === "researcher" ? [leafFinishTool({
        name: "wiki_research_finish",
        label: "Finish Wiki research",
        description: "Finish after writing the complete research handoff to .okf-wiki/task/handoff.md.",
        promptSnippet: "Finish the file-based research task",
        field: "status",
        allowed: ["complete", "incomplete"],
        finish: async (status) => {
          if (researchSignal) throw new Error("wiki_research_finish may be accepted only once");
          if (task.role !== "research") throw new Error("Research completion requires a research contract");
          const bytes = await readWikiWorkflowFile(policy.workspaceRoot, taskFileSlots.output);
          const markdown = Buffer.from(bytes).toString("utf8");
          const parsed = inspectResearchHandoff(bytes, status as "complete" | "incomplete", task.sourceScopeIds);
          const evidence = parsed.structural ? { defects: [] as string[] } : inspectEvidenceHandoff({ markdown, contract: task, fileLines });
          rejectHandoffDefects([...parsed.defects, ...evidence.defects]);
          markdownSnapshot = markdown;
          researchSignal = parsed.signal!;
        },
      })] : []),
      ...(role === "writer" ? [leafFinishTool({
        name: "wiki_write_finish",
        label: "Finish Wiki write",
        description: "Finish after writing the complete write handoff to .okf-wiki/task/handoff.md.",
        promptSnippet: "Finish the file-based write task",
        finish: async () => {
          if (writeFinished) throw new Error("wiki_write_finish may be accepted only once");
          const bytes = await readWikiWorkflowFile(policy.workspaceRoot, taskFileSlots.output);
          const markdown = Buffer.from(bytes).toString("utf8");
          rejectHandoffDefects(inspectEvidenceHandoff({ markdown, contract: task, fileLines }).defects);
          markdownSnapshot = markdown;
          writeFinished = true;
        },
      })] : []),
    ]);
    const taskSessionDir = this.options.sessionDir
      ? path.join(this.options.sessionDir, "tasks", String(context.batch), task.id, String(context.attempt))
      : undefined;
    const roleModel = this.roleModels?.[task.role] ?? { model: this.options.model, thinkingLevel: this.options.thinkingLevel };
    const sessionResult = await runPiSession(policy.workspaceRoot, tools, [
        "Read `.okf-wiki/task/brief.md` and complete the assigned task.",
        role === "writer" && this.generation ? `\nGeneration profile: ${JSON.stringify(this.generation)}. Treat it as reader intent, never as source evidence.` : "",
        role === "writer" ? `\n${writerFrontmatterPrompt(this.generation)}` : "",
      ].join(""), context.signal, {
        ...this.options,
        model: roleModel.model,
        thinkingLevel: roleModel.thinkingLevel,
        sessionDir: taskSessionDir,
        sessionFile: context.sessionFile,
        skillPath: this.options.skillRoot,
      }, context.onTelemetry, {
        target: { kind: "task", batch: context.batch, taskId: task.id },
        attempt: context.attempt,
        onHealth: context.reportObservability,
      }, undefined, this.options.skillRoot ? role : undefined);
    const markdown = markdownSnapshot?.trim() ?? "";
    if (!markdown) throw new Error("Delegated agent produced empty output");
    if (role === "reviewer" && !review) throw new Error("Reviewer completed without wiki_review_finish");
    if (role === "researcher" && !researchSignal) throw new Error("Researcher completed without wiki_research_finish");
    if (role === "writer" && !writeFinished) throw new Error("Writer completed without wiki_write_finish");
    return {
      summary: researchSignal?.summary ?? firstLine(markdown),
      markdown,
      usage: sessionResult.usage,
      ...(review ? { review } : {}),
      ...(researchSignal ? { status: researchSignal.status, research: researchSignal } : {}),
    };
  }
}

async function retrySleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new WikiTaskExecutionError("Wiki retry cancelled", "cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

const JSON_SCHEMA_PREFER = { type: "json_schema", strict: "prefer" } as const;
const PARALLEL_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

function withExecutionModes(tools: ToolDefinition<any, any, any>[]): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    executionMode: PARALLEL_READ_TOOLS.has(tool.name) ? "parallel" : "sequential",
  } as ToolDefinition<any, any, any>));
}

function leafFinishTool(input: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  field?: string;
  allowed?: readonly string[];
  finish: (value?: string) => void | Promise<void>;
}): ToolDefinition<any, any, any> {
  const { name, label, description, promptSnippet, field, allowed, finish } = input;
  return {
    name,
    label,
    description,
    promptSnippet,
    parameters: field && allowed
      ? Type.Object({ [field]: StringEnum([...allowed]) }, { additionalProperties: false })
      : Type.Object({}, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      if (field && allowed) {
        const value = exactLeafFinishInput(params, field, allowed, name);
        try {
          await finish(value);
        } catch (error) {
          rejectWikiTool(name, error);
        }
      } else {
        if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(`${name} requires an object`);
        const unknown = Object.keys(params as Record<string, unknown>);
        if (unknown.length) throw new Error(`${name} has unknown fields: ${unknown.join(", ")}`);
        try {
          await finish();
        } catch (error) {
          rejectWikiTool(name, error);
        }
      }
      return toolResult({ accepted: true });
    },
  } as ToolDefinition<any, any, any>;
}

function exactLeafFinishInput(value: unknown, field: string, allowed: readonly string[], tool: string): string {
  // Pi's preferred strict sampling is advisory; direct/provider calls can still
  // reach execute with extra prose fields, so runtime exactness remains required.
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${tool} requires an object`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => key !== field);
  if (unknown.length) throw new Error(`${tool} has unknown fields: ${unknown.join(", ")}`);
  if (typeof raw[field] !== "string" || !allowed.includes(raw[field] as string)) throw new Error(`${tool} has invalid ${field}`);
  return raw[field] as string;
}

function leafLanguageInstruction(role: "researcher" | "writer" | "reviewer", language?: "zh" | "en"): string {
  if (role === "researcher") {
    return "\nWrite the Markdown handoff as concise model-readable analysis. It does not need to use the Wiki reader language. Keep code identifiers and citations unchanged.";
  }
  return language === "zh"
    ? "\nUse Simplified Chinese for reader-facing Wiki content and the handoff. Keep code identifiers and citations unchanged."
    : "\nUse English for reader-facing Wiki content and the handoff. Keep code identifiers and citations unchanged.";
}

function writerFrontmatterPrompt(generation?: WikiGenerationProfile): string {
  const required = generation?.templates.requiredSections ?? [];
  return [
    "Write each assigned Wiki page with this frontmatter shape:",
    "---",
    "type: Domain",
    "title: Example",
    "description: One-sentence reader summary",
    "source: source-a",
    "sources:",
    "  - id: source-a",
    "    resource: source/path.ts#L1",
    "---",
    "Cite claims with [^source-a] and [^source-a]: [path.ts](source/path.ts#L1).",
    "Frontmatter type must match the WikiSpec pageType (Overview/Source/Domain/Architecture/Module/Flow/Concept/State/Data).",
    required.length ? `Required sections: ${required.join(", ")}.` : "",
  ].filter((line) => line.length > 0).join("\n");
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function runBoardPath(runId: string): string {
  return `.okf-wiki/runs/${runId}/board.md`;
}

function createLeadFileSlots(workspaceRoot: string, runId: string, sourceCount: number): WikiWorkflowFileSlot[] {
  const currentRoot = path.join(workspaceRoot, ".okf-wiki", "runs", runId, "work-files", "current");
  const slots: WikiWorkflowFileSlot[] = [
    { logicalPath: ".okf-wiki/current/board.md", physicalPath: path.join(workspaceRoot, runBoardPath(runId)), writable: false },
    { logicalPath: ".okf-wiki/current/taxonomy.yaml", physicalPath: path.join(currentRoot, "taxonomy.yaml"), writable: true },
    { logicalPath: ".okf-wiki/current/wiki-spec.yaml", physicalPath: path.join(currentRoot, "wiki-spec.yaml"), writable: true },
    { logicalPath: ".okf-wiki/current/completion.md", physicalPath: path.join(currentRoot, "completion.md"), writable: true },
  ];
  for (let index = 1; index <= sourceCount; index += 1) {
    const name = `source-${String(index).padStart(3, "0")}.md`;
    slots.push({ logicalPath: `.okf-wiki/current/research/${name}`, physicalPath: path.join(currentRoot, "research", name), writable: true });
  }
  return slots;
}

function createTaskFileSlots(
  workspaceRoot: string,
  context: WikiLeafTaskContext,
  task: WikiDelegateContract,
  role: "researcher" | "writer" | "reviewer",
): { brief: WikiWorkflowFileSlot; output: WikiWorkflowFileSlot; slots: WikiWorkflowFileSlot[] } {
  const taskRoot = path.join(
    workspaceRoot,
    ".okf-wiki",
    "runs",
    context.runId,
    "task-files",
    String(context.batch),
    task.id,
    String(context.attempt),
  );
  const brief: WikiWorkflowFileSlot = {
    logicalPath: ".okf-wiki/task/brief.md",
    physicalPath: path.join(taskRoot, "brief.md"),
    writable: false,
  };
  const outputName = role === "reviewer" ? "review.md" : "handoff.md";
  const output: WikiWorkflowFileSlot = {
    logicalPath: `.okf-wiki/task/${outputName}`,
    physicalPath: path.join(taskRoot, outputName),
    writable: true,
  };
  return { brief, output, slots: [brief, output] };
}

function taskFileBrief(
  task: WikiDelegateContract,
  artifacts: readonly { id: string; path: string; sha256: string; sizeBytes: number }[],
  reviewIndexes: readonly string[],
  language?: "zh" | "en",
): string {
  return [
    `# ${task.role} task`,
    "",
    "## Assignment",
    "",
    task.instruction,
    "",
    `- readable Sources: ${task.sourceScopeIds.join(", ") || "(none)"}`,
    task.writePaths?.length ? `- write paths: ${task.writePaths.join(", ")}` : "",
    task.reviewPaths?.length ? `- review paths: ${task.reviewPaths.join(", ")}` : "",
    reviewIndexes.length ? `- deterministic index paths (read only): ${reviewIndexes.join(", ")}` : "",
    `- ${leafLanguageInstruction(task.role === "write" ? "writer" : task.role === "review" ? "reviewer" : "researcher", language).trim()}`,
    ...artifacts.map((artifact) => `- context: ${artifact.path} (${artifact.sizeBytes} bytes, sha256 ${artifact.sha256})`),
    task.role === "review"
      ? "- completion: write `.okf-wiki/task/review.md`, then call wiki_review_finish with only the verdict"
      : task.role === "research"
        ? "- completion: write `.okf-wiki/task/handoff.md`, then call wiki_research_finish with only the status"
        : "- completion: write `.okf-wiki/task/handoff.md`, then call wiki_write_finish with no arguments",
    "",
  ].filter((line) => line !== "").join("\n");
}

function defaultWikiSpecDraft(sourceScopeIds: readonly string[]): string {
  const pages = ["overview.md", ...sourceScopeIds.map((scopeId) => `${scopeId}/source.md`)];
  return ["topologyVersion: 2", "pages:", ...pages.map((page) => `  - ${page}`), ""].join("\n");
}

async function ensureLeadFileDrafts(workspaceRoot: string, slots: readonly WikiWorkflowFileSlot[], sourceScopeIds: readonly string[]): Promise<void> {
  const defaults = new Map<string, string>([
    [".okf-wiki/current/taxonomy.yaml", "revision: 1\ndecisions: []\nconflictIds: []\n"],
    [".okf-wiki/current/wiki-spec.yaml", defaultWikiSpecDraft(sourceScopeIds)],
    [".okf-wiki/current/completion.md", ""],
  ]);
  const research = slots.filter((slot) => slot.logicalPath.startsWith(".okf-wiki/current/research/"));
  for (let index = 0; index < sourceScopeIds.length; index += 1) {
    defaults.set(research[index].logicalPath, "Inventory this pinned Source: domains, concepts, entry points, public interfaces, important flows, and cross-source relationships. Cite locators and preserve local terminology, conflicts, and minority evidence.\n");
  }
  for (const [logicalPath, content] of defaults) {
    const slot = leadSlot(slots, logicalPath);
    try { await readWikiWorkflowFile(workspaceRoot, slot); }
    catch (error) {
      if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeWikiWorkflowFile(workspaceRoot, slot, content);
    }
  }
}

async function prefillTaxonomyDraft(
  leadRun: WikiLeadRun,
  workspaceRoot: string,
  slots: readonly WikiWorkflowFileSlot[],
  snapshot: { status: string; receipts: WikiAgentOutcome[] },
): Promise<void> {
  if (leadRun.taxonomyCheckpoint || snapshot.status !== "complete") return;
  if (leadRun.nextAction !== "taxonomy") return;
  const incoming = leadRun.researchTaxonomyDecisions();
  if (!incoming.length) return;
  const slot = leadSlot(slots, ".okf-wiki/current/taxonomy.yaml");
  let current: { revision?: unknown; decisions?: unknown; conflictIds?: unknown } = {};
  try {
    current = YAML.parse(decodeUtf8Fatal(await readWikiWorkflowFile(workspaceRoot, slot))) as typeof current;
  } catch (error) {
    if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const currentDecisions = Array.isArray(current.decisions) ? current.decisions as WikiBoardTaxonomyDecision[] : [];
  const collectedSources = [...new Set(snapshot.receipts.flatMap((receipt) => receipt.domains ?? []).map((domain) => domain.sourceScopeId))];
  const decisions = currentDecisions.length === 0
    ? incoming
    : mergeTaxonomyDecisions(currentDecisions, incoming, collectedSources);
  const conflictIds = Array.isArray(current.conflictIds) ? current.conflictIds.filter((id): id is string => typeof id === "string") : [];
  const revision = Number.isSafeInteger(current.revision) && (current.revision as number) >= 1 ? current.revision as number : 1;
  await writeWikiWorkflowFile(workspaceRoot, slot, formatTaxonomyDraft(revision, decisions, conflictIds));
}

function formatTaxonomyDraft(revision: number, decisions: readonly WikiBoardTaxonomyDecision[], conflictIds: readonly string[]): string {
  return YAML.stringify({ revision, decisions, conflictIds });
}

function leadSlot(slots: readonly WikiWorkflowFileSlot[], logicalPath: string): WikiWorkflowFileSlot {
  const slot = slots.find((entry) => entry.logicalPath === logicalPath);
  if (!slot) throw new Error(`Missing fixed Wiki workflow file: ${logicalPath}`);
  return slot;
}

async function readDiscoveryPlan(
  workspaceRoot: string,
  slots: readonly WikiWorkflowFileSlot[],
  sourceScopeIds: readonly string[],
): Promise<Array<{ sourceScopeId: string; instruction: string }>> {
  const research = slots.filter((slot) => slot.logicalPath.startsWith(".okf-wiki/current/research/"));
  const defects: string[] = [];
  const entries = await Promise.all(sourceScopeIds.map(async (sourceScopeId, index) => {
    const instruction = decodeUtf8Fatal(await readWikiWorkflowFile(workspaceRoot, research[index])).trim();
    if (!instruction) {
      defects.push(`Discovery direction file is empty: ${research[index].logicalPath}`);
      return undefined;
    }
    return { sourceScopeId, instruction };
  }));
  if (defects.length) throw new WikiRejectedError(defects);
  return entries.filter((entry): entry is { sourceScopeId: string; instruction: string } => entry !== undefined);
}

async function readYamlWorkflowFile(workspaceRoot: string, slot: WikiWorkflowFileSlot): Promise<unknown> {
  const source = decodeUtf8Fatal(await readWikiWorkflowFile(workspaceRoot, slot));
  try {
    return YAML.parse(source);
  } catch (error) {
    throw new Error(`Invalid YAML in ${slot.logicalPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function workflowCompletionSummary(markdown: string): string {
  return summarizeWikiMarkdown(markdown, "completion.md");
}

function leadSessionPrompt(prompt: string, sourceCount: number): string {
  const researchFiles = Array.from({ length: sourceCount }, (_, index) => `.okf-wiki/current/research/source-${String(index + 1).padStart(3, "0")}.md`);
  const additions = [
    prompt.includes(".okf-wiki/current/board.md") ? "" : "Board: .okf-wiki/current/board.md. Read it before dispatch or wiki_finish.",
    researchFiles.length ? `Fixed discovery files: ${researchFiles.join(", ")}.` : "",
    prompt.includes("wiki_taxonomy") ? "" : "Submit wiki_taxonomy after discovery and before wiki_plan.",
    prompt.includes("topology.md") ? "" : "Read topology.md before wiki_plan.",
  ].filter(Boolean);
  return additions.length ? `${prompt}\n${additions.join(" ")}` : prompt;
}

function withBoard<T extends object>(compactionObserved: boolean, value: T): T & { board: string; note?: string } {
  return {
    ...value,
    board: ".okf-wiki/current/board.md",
    ...(compactionObserved ? { note: "Read board.md before dispatching or finishing" } : {}),
  };
}

function rejectHandoffDefects(defects: readonly string[]): void {
  if (defects.length) throw new WikiRejectedError(defects);
}

function evidenceFileLines(plan: WikiPinnedSourcePlan): (citation: EvidenceLedgerCitation) => number | "missing" | undefined {
  return (citation) => {
    const source = plan.sources.find((entry) => entry.scopeId === citation.scope);
    if (!source) return undefined;
    try {
      const text = readFileSync(inside(source.realPath, path.resolve(source.realPath, ...citation.path.split("/"))), "utf8");
      if (!text) return 0;
      const lines = text.split(/\r?\n/).length;
      return text.endsWith("\n") ? lines - 1 : lines;
    } catch {
      return "missing";
    }
  };
}

function rejectWikiTool(tool: string, error: unknown): never {
  if (error instanceof Error && error.message.startsWith(`${tool} rejected:`)) throw error;
  throw wikiToolRejected(tool, error instanceof Error ? error.message : String(error));
}

function roleSkill(skillRoot: string, role: "researcher" | "writer" | "reviewer"): Skill {
  const filePath = path.join(skillRoot, "briefs", `${role}.md`);
  if (!existsSync(filePath)) throw new Error(`Wiki ${role} brief is unavailable: briefs/${role}.md`);
  return {
    name: `wiki-${role}`,
    description: `Complete the assigned Wiki ${role} task. Load this skill, then read references relative to its directory.`,
    filePath,
    baseDir: skillRoot,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "sdk", baseDir: skillRoot }),
    disableModelInvocation: false,
  };
}

function sessionBudgets(
  base: WikiExecutionBudgets | undefined,
  override?: Pick<WikiExecutionBudgets, "maxTurnsPerSession" | "maxToolCallsPerSession">,
): WikiExecutionBudgets | undefined {
  if (!override) return base;
  if (!base) return { maxDelegatedTasks: 1, maxDelegateBatches: 1, ...override };
  return { ...base, ...override };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim() || "Delegated task completed";
}

function applyTelemetry(snapshot: WikiAgentSnapshot, telemetry?: WikiAgentTelemetry): void {
  if (!telemetry) return;
  snapshot.attempt = telemetry.attempt;
  snapshot.updatedAt = telemetry.sampledAt;
  if (telemetry.activity) snapshot.activity = telemetry.activity;
  if (telemetry.activeTools) snapshot.activeTools = telemetry.activeTools;
  if (telemetry.usage) snapshot.usage = telemetry.usage;
  if (telemetry.lastActivityAt) snapshot.lastActivityAt = telemetry.lastActivityAt;
  if (telemetry.lastHeartbeatAt) snapshot.lastHeartbeatAt = telemetry.lastHeartbeatAt;
  if (telemetry.deadlineAt) snapshot.deadlineAt = telemetry.deadlineAt;
  if (telemetry.process) snapshot.process = telemetry.process;
}

function addWikiPrefix(value: string): string { return `wiki/${value}`; }

type ThinkingClock = {
  pause(): void;
  resume(): void;
  remainingMs(): number;
};

function createThinkingClock(timeoutMs: number): ThinkingClock {
  return {
    pause() {},
    resume() {},
    remainingMs: () => timeoutMs,
  };
}

async function runSessionWithDeadline(
  session: AgentSession,
  prompt: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  thinkingClock?: ThinkingClock,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let remaining = timeoutMs;
  let startedAt = Date.now();
  let paused = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fire = () => {
      void session.abort();
      reject(new WikiTaskExecutionError(`Wiki agent session timed out after ${timeoutMs}ms`, "timeout"));
    };
    const arm = () => {
      timer = setTimeout(fire, remaining);
    };
    if (thinkingClock) {
      thinkingClock.pause = () => {
        if (paused || timer === undefined) return;
        paused = true;
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      };
      thinkingClock.resume = () => {
        if (!paused) return;
        paused = false;
        startedAt = Date.now();
        arm();
      };
      thinkingClock.remainingMs = () => paused || timer === undefined
        ? remaining
        : Math.max(0, remaining - (Date.now() - startedAt));
    }
    arm();
  });
  try {
    if (signal.aborted) throw new WikiTaskExecutionError("Wiki agent session cancelled", "cancelled");
    await Promise.race([session.prompt(prompt), deadline]);
    await Promise.race([session.waitForIdle(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (thinkingClock) {
      thinkingClock.pause = () => {};
      thinkingClock.resume = () => {};
      thinkingClock.remainingMs = () => timeoutMs;
    }
  }
}

function validatedSessionTimeoutMs(timeoutMs = DEFAULT_SESSION_TIMEOUT_MS): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_SESSION_TIMEOUT_MS) {
    throw new Error(`sessionTimeoutMs must be an integer from 1000 to ${MAX_SESSION_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

async function runPiSession(
  cwd: string,
  tools: ToolDefinition<any, any, any>[],
  prompt: string,
  signal: AbortSignal,
  options: PiWikiLeadAgentOptions,
  onTelemetry?: (telemetry: WikiAgentTelemetry) => void | Promise<void>,
  observer?: ObserverContext,
  onReady?: (session: AgentSession) => void,
  role?: "researcher" | "writer" | "reviewer",
): Promise<{ text: string; usage?: WikiContextStats }> {
  // TaskRuntime owns configurable transient retries by creating fresh sessions.
  // Disable both Pi turn retry and provider request retry so budgets cannot multiply.
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: false, maxRetries: PI_SESSION_REQUEST_RETRIES, provider: { maxRetries: PI_SESSION_REQUEST_RETRIES } },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: options.skillPath ? [options.skillPath] : [],
    ...(role && options.skillPath ? { skillsOverride: () => ({ skills: [roleSkill(options.skillPath!, role)], diagnostics: [] }) } : {}),
  });
  await loader.reload();
  const sessionFile = options.sessionFile;
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, options.sessionDir, cwd)
    : SessionManager.create(cwd, options.sessionDir);
  let session: AgentSession | undefined;
  let budgetError: WikiBudgetExhaustedError | undefined;
  let toolCalls = 0;
  const guardedTools = tools.map((tool) => {
    const execute = tool.execute;
    return {
      ...tool,
      async execute(toolCallId, params, toolSignal, onUpdate, context) {
        const limit = options.budgets?.maxToolCallsPerSession;
        if (limit !== undefined && toolCalls >= limit) {
          budgetError = sessionToolBudgetError(limit, toolCalls);
          void session?.abort();
          throw budgetError;
        }
        toolCalls += 1;
        return await execute(toolCallId, params, toolSignal, onUpdate, context);
      },
    } as ToolDefinition<any, any, any>;
  });
  const createOptions: CreateAgentSessionOptions = {
    cwd,
    sessionManager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: "builtin",
    tools: guardedTools.map((tool) => tool.name),
    customTools: guardedTools,
    ...(!sessionFile ? { model: options.model, thinkingLevel: options.thinkingLevel } : {}),
  };
  const created = await (options.createSession ?? createAgentSession)(createOptions);
  session = created.session;
  onReady?.(session);
  if (created.modelFallbackMessage) {
    session.dispose();
    throw new Error(`Could not restore the persisted Wiki model: ${created.modelFallbackMessage}`);
  }
  const sessionObserver = onTelemetry && observer
    ? new PiSessionObserver(session, {
      ...observer,
      timeoutMs: options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      remainingTimeoutMs: observer.thinkingClock ? () => observer.thinkingClock!.remainingMs() : undefined,
      workspaceRoot: cwd,
      report: onTelemetry,
      onHealth: observer.onHealth,
    })
    : undefined;
  const abort = () => { void session.abort(); };
  const initialUsage = readSessionUsage(session);
  let turns = initialUsage?.turns ?? 0;
  toolCalls = initialUsage?.toolCalls ?? 0;
  if (options.budgets && turns >= options.budgets.maxTurnsPerSession) {
    session.dispose();
    throw sessionTurnBudgetError(options.budgets.maxTurnsPerSession, turns);
  }
  if (options.budgets && toolCalls >= options.budgets.maxToolCallsPerSession) {
    session.dispose();
    throw sessionToolBudgetError(options.budgets.maxToolCallsPerSession, toolCalls);
  }
  const stopBudgetMonitor = typeof session.subscribe === "function"
    ? session.subscribe((event) => {
      if (event.type === "turn_end") turns += 1;
      if (event.type === "turn_start" && !budgetError && options.budgets && turns >= options.budgets.maxTurnsPerSession) {
        budgetError = sessionTurnBudgetError(options.budgets.maxTurnsPerSession, turns);
      }
      if (budgetError) void session.abort();
    })
    : undefined;
  signal.addEventListener("abort", abort, { once: true });
  try {
    sessionObserver?.start();
    try {
      await runSessionWithDeadline(session, prompt, signal, options.sessionTimeoutMs, observer?.thinkingClock);
    } catch (error) {
      const failure = budgetError ?? (signal.aborted ? sessionAbortReason(signal) : error);
      await sessionObserver?.failed(failure);
      throw failure;
    }
    if (budgetError) throw budgetError;
    if (signal.aborted) throw sessionAbortReason(signal);
    const stateError = typeof session.state.errorMessage === "string" ? session.state.errorMessage : undefined;
    if (stateError) throw new Error(stateError);
    const text = session.getLastAssistantText() ?? "";
    return { text, usage: readSessionUsage(session) };
  } finally {
    signal.removeEventListener("abort", abort);
    stopBudgetMonitor?.();
    await sessionObserver?.stop();
    session.dispose();
  }
}

function sessionAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === "string" && signal.reason.trim()
    ? signal.reason
    : "Wiki agent session cancelled";
  return new WikiTaskExecutionError(message, "cancelled", { cause: signal.reason });
}

function sessionTurnBudgetError(limit: number, turns: number): WikiBudgetExhaustedError {
  return new WikiBudgetExhaustedError(
    `Pi session turn limit exhausted (${limit})`,
    "session_turns_exhausted",
    { limit, turns },
  );
}

function sessionToolBudgetError(limit: number, toolCalls: number): WikiBudgetExhaustedError {
  return new WikiBudgetExhaustedError(
    `Pi session tool-call limit exhausted (${limit})`,
    "session_tool_calls_exhausted",
    { limit, toolCalls },
  );
}

type ObserverContext = {
  target: WikiAgentTelemetry["target"];
  attempt: number;
  now?: () => number;
  onHealth?: PiSessionObserverOptions["onHealth"];
  thinkingClock?: ThinkingClock;
};
