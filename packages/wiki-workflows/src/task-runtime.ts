import type { WikiArtifactRef, WikiArtifactStore } from "./artifact-store.js";
import {
  boundedDelegateSummary,
  parseWikiDelegateContract,
  WikiTaskExecutionError,
  WikiTaskPauseError,
  type WikiDelegateBatchSnapshot,
  type WikiDelegateError,
  type WikiDelegateGap,
  type WikiDelegateReceipt,
  type WikiDelegateRole,
  type WikiDelegateContract,
  type WikiTaskFailureCode,
  createWikiResearchCompletion,
  type WikiResearchCompletion,
  type WikiResearchSignal,
  canonicalWikiFollowupId,
  truncateUtf8,
  type WikiDelegateFollowup,
} from "./delegate-contracts.js";
import { ingestEvidenceHandoff } from "./evidence-ledger.js";
import { WikiRejectedError } from "./wiki-reject.js";
import { classifyWikiAttemptFailure, decideWikiAgentAttempt } from "./agent-attempt-policy.js";
import { WikiBudgetExhaustedError } from "./failures.js";
import { WIKI_MANUAL_PAUSE } from "./runtime-types.js";
import type {
  WikiAgentTarget,
  WikiAgentTelemetry,
  WikiContextStats,
} from "./producer-types.js";
import type { WikiTaskRuntimeState, WikiTaskRuntimeTaskState } from "./runtime-types.js";
import type { WikiReviewResult } from "./delegate-contracts.js";
import type { WikiTaskRuntimeTransitions } from "./lead.js";

type WikiObservabilityHealth = { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string };
import { isSafeWikiPagePath } from "./lead.js";

export type WikiTaskProgressPhase = "queued" | "start" | "update" | "end";

export interface WikiTaskProgressEvent {
  readonly batchId: number;
  phase: WikiTaskProgressPhase;
  task: WikiDelegateContract;
  receipt?: WikiDelegateReceipt; // required on end
  usage?: WikiContextStats;
  telemetry?: WikiAgentTelemetry;
}

export interface WikiLeafTaskContext {
  runId: string;
  batch: number;
  attempt: number;
  contextArtifacts: Record<string, WikiArtifactRef>;
  sessionFile?: string;
  candidateWikiRoot?: string;
  signal: AbortSignal;
  onTelemetry?: (telemetry: WikiAgentTelemetry) => void | Promise<void>;
  reportObservability?: (input: WikiObservabilityHealth) => void | Promise<void>;
}

export interface WikiLeafResult {
  summary: string;
  markdown: string;
  coverage?: string[];
  gaps?: WikiDelegateGap[];
  status?: "complete" | "incomplete";
  usage?: WikiContextStats;
  review?: WikiReviewResult;
  research?: WikiResearchSignal;
}

export interface WikiLeafAgent {
  run(task: WikiDelegateContract, context: WikiLeafTaskContext): Promise<WikiLeafResult>;
}

export interface WikiTaskRuntimeOptions {
  runId: string;
  sourceScopes: readonly string[];
  contextArtifacts?: Readonly<Record<string, WikiArtifactRef>>;
  candidateWikiRoot?: string;
  artifactStore: WikiArtifactStore;
  agent: WikiLeafAgent;
  concurrency?: number;
  maxDelegatedTasks?: number;
  maxDelegateBatches?: number;
  restoredState?: WikiTaskRuntimeState;
  transitions: WikiTaskRuntimeTransitions;
  writeLease?: WikiWritePathLease;
  transientRetries?: number;
  baseRetryDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onTask?: (event: WikiTaskProgressEvent) => void | Promise<void>;
  reportObservability?: (input: WikiObservabilityHealth) => void | Promise<void>;
}

export class WikiTaskRuntime {
  private readonly gate: SharedAdmissionGate;
  private readonly writePaths: WikiWritePathLease;
  private readonly contextArtifacts: Record<string, WikiArtifactRef>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly baseRetryDelayMs: number;
  private readonly transientRetries: number;
  private readonly onTask?: (event: WikiTaskProgressEvent) => void | Promise<void>;
  private readonly batches = new Map<number, AsyncBatch>();
  private readonly maxDelegatedTasks: number;
  private readonly maxDelegateBatches: number;
  private delegatedTasks = 0;
  private delegateBatches = 0;
  private stateFailure: unknown;

  constructor(private readonly options: WikiTaskRuntimeOptions) {
    this.gate = new SharedAdmissionGate(options.concurrency ?? 2, options.now);
    this.writePaths = options.writeLease ?? new WikiWritePathLease();
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.transientRetries = options.transientRetries ?? 1;
    this.maxDelegatedTasks = options.maxDelegatedTasks ?? Number.POSITIVE_INFINITY;
    this.maxDelegateBatches = options.maxDelegateBatches ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(this.transientRetries) || this.transientRetries < 0) throw new Error("transientRetries must be a non-negative integer");
    if (!Number.isFinite(this.baseRetryDelayMs) || this.baseRetryDelayMs < 0) throw new Error("baseRetryDelayMs must be non-negative");
    validateLimit(this.maxDelegatedTasks, "maxDelegatedTasks");
    validateLimit(this.maxDelegateBatches, "maxDelegateBatches");
    this.contextArtifacts = Object.fromEntries(Object.values(options.contextArtifacts ?? {}).map((ref) => [ref.nodeId, ref]));
    this.onTask = options.onTask;
    if (options.restoredState) this.restore(options.restoredState);
  }

  async start(tasks: readonly WikiDelegateContract[], signal: AbortSignal): Promise<{ batchId: number }> {
    this.assertStateHealthy();
    const requests = tasks.map(parseWikiDelegateContract);
    validateBatch(requests, this.options);
    for (const task of requests) {
      for (const ref of task.contextRefs) {
        if (!Object.hasOwn(this.contextArtifacts, ref)) throw new Error(`Delegate task ${task.id} requests undeclared context artifact: ${ref}`);
      }
    }
    if (requests.some((task) => task.role === "review")) {
      this.writePaths.assertReviewAllowed();
      const pendingWrite = [...this.batches.values()].some((batch) => [...batch.records.values()].some(
        (record) => record.state.task.role === "write" && record.state.phase !== "terminal",
      ));
      if (pendingWrite || requests.some((task) => task.role === "write")) throw new Error("Wiki review is blocked while delegated Wiki writes are pending");
    }
    if (this.delegateBatches >= this.maxDelegateBatches) {
      throw new WikiBudgetExhaustedError(
        `Delegate batch limit exhausted (${this.maxDelegateBatches})`,
        "delegate_batches_exhausted",
        { limit: this.maxDelegateBatches },
      );
    }
    if (this.delegatedTasks + requests.length > this.maxDelegatedTasks) {
      throw new WikiBudgetExhaustedError(
        `Delegated task limit exhausted (${this.maxDelegatedTasks})`,
        "delegated_tasks_exhausted",
        { limit: this.maxDelegatedTasks, delegatedTasks: this.delegatedTasks, requestedTasks: requests.length },
      );
    }

    const batchId = requests[0]?.batchId;
    if (batchId === undefined || requests.some((task) => task.batchId !== batchId)) throw new Error("Wiki delegate contracts must belong to one batch");
    if (this.batches.has(batchId)) throw new Error(`Duplicate delegate batch: ${batchId}`);
    for (const task of requests) artifactNodeId(batchId, task.id);
    await this.options.transitions.batchQueued(requests);
    const records = new Map(requests.map((task) => [task.id, createAsyncTask({
      task,
      phase: "queued",
      attempt: 0,
      collected: false,
    })] as const));
    const batch: AsyncBatch = { id: batchId, records };
    this.batches.set(batchId, batch);
    this.delegatedTasks += records.size;
    this.delegateBatches += 1;
    void this.launchBatch(batch, signal).catch((error) => { this.stateFailure ??= error; });
    return { batchId };
  }

  async resume(signal: AbortSignal): Promise<void> {
    this.assertStateHealthy();
    for (const batch of this.batches.values()) {
      for (const record of batch.records.values()) {
        if (record.state.phase === "paused") {
          await this.transition(() => this.options.transitions.taskStarted(batch.id, record.state.task.id, {
            attempt: record.state.attempt,
            ...(record.state.sessionFile ? { sessionFile: record.state.sessionFile } : {}),
            ...(record.state.partial ? { partial: record.state.partial } : {}),
          }));
          record.state.phase = "running";
          delete record.state.pause;
        }
        if (record.state.phase !== "terminal" && !record.launched && record.settled) resetAsyncTask(record);
      }
    }
    for (const batch of this.batches.values()) {
      if ([...batch.records.values()].some((record) => record.state.phase !== "terminal" && !record.launched)) {
        void this.launchBatch(batch, signal).catch((error) => { this.stateFailure ??= error; });
      }
    }
  }

  async collect(
    batchId: number,
    options: { until: "any" | "all"; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): Promise<WikiDelegateBatchSnapshot> {
    const batch = this.requireBatch(batchId);
    this.assertStateHealthy();
    validateCollectOptions(options);
    const shouldWait = !this.collectSatisfied(batch, options.until)
      && (options.timeoutSeconds === undefined || options.timeoutSeconds > 0);
    if (shouldWait) {
      await waitWithTimeout(
        this.waitForCollect(batch, options.until),
        options.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1_000,
        signal,
      );
    }
    this.assertStateHealthy();
    const result = this.snapshot(batch);
    this.throwForPause(batch);
    const collected: string[] = [];
    for (const record of batch.records.values()) {
      if (record.state.phase === "terminal" && !record.state.collected) {
        collected.push(record.state.task.id);
      }
    }
    if (collected.length) {
      await this.transition(() => this.options.transitions.tasksCollected(batchId, collected));
      for (const id of collected) batch.records.get(id)!.state.collected = true;
    }
    return result;
  }

  async cancel(batchId: number, taskIds?: readonly string[], reason = "Delegate task cancelled"): Promise<WikiDelegateBatchSnapshot> {
    const batch = this.requireBatch(batchId);
    this.assertStateHealthy();
    const ids = taskIds === undefined ? [...batch.records.keys()] : [...new Set(taskIds)];
    for (const id of ids) {
      if (!batch.records.has(id)) throw new Error(`Unknown delegate task ${id} in batch ${batchId}`);
    }
    const cancellation = new WikiTaskExecutionError(reason.trim() || "Delegate task cancelled", "cancelled");
    const directlyCancelled: AsyncTask[] = [];
    for (const id of ids) {
      const record = batch.records.get(id)!;
      if (record.state.phase === "terminal") continue;
      if (record.launched) record.controller.abort(cancellation);
      else {
        const failure = classifyWikiAttemptFailure(cancellation);
        await this.transition(() => this.options.transitions.taskStarted(batchId, id, { attempt: 1 }));
        record.state.phase = "running";
        record.state.attempt = 1;
        const terminal = receiptFromState(record.state, failure);
        await this.transition(() => this.options.transitions.taskSettled(batchId, id, { attempt: 1, receipt: terminal }));
        record.state.phase = "terminal";
        record.state.receipt = terminal;
        delete record.state.pause;
        delete record.state.partial;
        record.launched = true;
        settleAsyncTask(record);
        directlyCancelled.push(record);
      }
    }
    if (directlyCancelled.length) {
      for (const record of directlyCancelled) {
        await this.fireProgress({ batchId, phase: "end", task: record.state.task, receipt: terminalReceipt(record.state) });
      }
    }
    await Promise.all(ids.map((id) => batch.records.get(id)!.done));
    this.assertStateHealthy();
    const result = this.snapshot(batch);
    this.throwForPause(batch);
    const collected: string[] = [];
    for (const record of batch.records.values()) {
      if (record.state.phase === "terminal" && !record.state.collected) {
        collected.push(record.state.task.id);
      }
    }
    if (collected.length) {
      await this.transition(() => this.options.transitions.tasksCollected(batchId, collected));
      for (const id of collected) batch.records.get(id)!.state.collected = true;
    }
    return result;
  }

  assertFinishable(): void {
    this.assertStateHealthy();
    for (const batch of this.batches.values()) {
      for (const record of batch.records.values()) {
        const pause = record.state.pause;
        if (record.state.phase === "paused" && pause && (pause.code === "quota" || pause.code === "usage_limit")) {
          throw new WikiTaskPauseError(pause.code, pause.message, pause.retryAfterMs);
        }
      }
    }
    const defects: string[] = [];
    if (this.writePaths.hasActive()) defects.push("wiki_finish is blocked while Wiki writes are active");
    const unfinished: string[] = [];
    const uncollected: string[] = [];
    for (const batch of this.batches.values()) {
      for (const record of batch.records.values()) {
        if (record.state.phase !== "terminal") unfinished.push(record.state.task.id);
        else if (!record.state.collected) uncollected.push(record.state.task.id);
      }
    }
    if (unfinished.length) defects.push(`wiki_finish requires terminal tasks: ${unfinished.join(", ")}`);
    if (uncollected.length) defects.push(`wiki_finish requires collected receipts: ${uncollected.join(", ")}`);
    if (defects.length) throw new WikiRejectedError(defects);
  }

  private async launchBatch(batch: AsyncBatch, signal: AbortSignal): Promise<void> {
    for (const record of batch.records.values()) {
      if (record.launched || record.state.phase === "terminal") continue;
      record.launched = true;
      await this.fireProgress({ batchId: batch.id, phase: "queued", task: record.state.task });
      void this.launchTask(batch, record, signal).catch((error) => {
        this.stateFailure ??= error;
        settleAsyncTask(record);
      });
    }
  }

  private async launchTask(batch: AsyncBatch, record: AsyncTask, runSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([runSignal, record.controller.signal]);
    let releaseWrites: (() => void) | undefined;
    let outcome: TaskExecutionOutcome;
    try {
      if (record.state.task.role === "review") {
        this.writePaths.assertReviewAllowed();
        const pendingWrite = [...this.batches.values()].some((candidate) => [...candidate.records.values()].some(
          (other) => other !== record && other.state.task.role === "write" && other.state.phase !== "terminal",
        ));
        if (pendingWrite) throw new Error("Wiki review is blocked while delegated Wiki writes are pending");
      }
      releaseWrites = await this.writePaths.acquire(record.state.task.writePaths ?? [], signal);
      outcome = await this.execute(record, batch.id, signal);
    } catch (error) {
      this.assertStateHealthy();
      const interruption = pauseInterruption(signal);
      if (interruption !== undefined) outcome = { kind: "paused", pause: interruption.pause };
      else {
        const failure = classifyWikiAttemptFailure(signal.aborted ? signal.reason ?? error : error, signal.aborted);
        outcome = { kind: "terminal", receipt: receiptFromState(record.state, failure) };
      }
    } finally {
      releaseWrites?.();
    }
    if (outcome!.kind === "paused") {
      if (record.state.attempt > 0) {
        await this.transition(() => this.options.transitions.taskPaused(batch.id, record.state.task.id, {
          attempt: record.state.attempt,
          ...(outcome!.pause ? { pause: outcome!.pause } : {}),
          ...(record.state.sessionFile ? { sessionFile: record.state.sessionFile } : {}),
          ...(record.state.partial ? { partial: record.state.partial } : {}),
        }));
      }
      record.state.phase = record.state.attempt > 0 ? "paused" : "queued";
      if (outcome!.pause) record.state.pause = outcome!.pause;
      else delete record.state.pause;
      delete record.state.receipt;
      record.state.collected = false;
      record.launched = false;
      settleAsyncTask(record);
      return;
    }
    await this.transition(() => this.options.transitions.taskSettled(batch.id, record.state.task.id, {
      attempt: record.state.attempt,
      receipt: outcome!.receipt,
      ...(record.state.sessionFile ? { sessionFile: record.state.sessionFile } : {}),
    }));
    record.state.phase = "terminal";
    record.state.receipt = outcome!.receipt;
    delete record.state.pause;
    delete record.state.partial;
    const output = outcome!.receipt.outputs.at(-1);
    if (output) this.contextArtifacts[output.nodeId] = output;
    await this.fireProgress({
      batchId: batch.id,
      phase: "end",
      task: record.state.task,
      receipt: outcome!.receipt,
      usage: outcome!.usage,
      telemetry: outcome!.telemetry,
    });
    settleAsyncTask(record);
  }

  private collectSatisfied(batch: AsyncBatch, until: "any" | "all"): boolean {
    const records = [...batch.records.values()];
    return until === "all"
      ? records.every((record) => record.state.phase === "terminal") || records.some((record) => record.state.phase === "paused")
      : records.some((record) => record.state.phase === "paused" || (record.state.phase === "terminal" && !record.state.collected));
  }

  private async waitForCollect(batch: AsyncBatch, until: "any" | "all"): Promise<void> {
    while (!this.collectSatisfied(batch, until)) {
      const pending = [...batch.records.values()].filter((record) => record.state.phase !== "terminal" && !record.settled);
      if (pending.length === 0) return;
      await Promise.race(pending.map((record) => record.done));
    }
  }

  private requireBatch(batchId: number): AsyncBatch {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`Unknown delegate batch: ${batchId}`);
    return batch;
  }

  private snapshot(batch: AsyncBatch): WikiDelegateBatchSnapshot {
    const states = [...batch.records.values()].map((record) => record.state);
    const receipts = states.flatMap((state) => state.phase === "terminal" ? [terminalReceipt(state)] : []);
    const pendingTaskIds = states.filter((state) => state.phase !== "terminal").map((state) => state.task.id);
    const complete = receipts.filter((value) => value.status === "complete").length;
    return {
      batchId: batch.id,
      status: pendingTaskIds.length > 0 ? "running" : (complete === receipts.length ? "complete" : complete > 0 ? "partial" : "failed"),
      receipts,
      pendingTaskIds,
    };
  }

  private throwForPause(batch: AsyncBatch): void {
    const pause = [...batch.records.values()].find((record) => record.state.phase === "paused" && record.state.pause)?.state.pause;
    if (pause && (pause.code === "quota" || pause.code === "usage_limit")) {
      throw new WikiTaskPauseError(pause.code, pause.message, pause.retryAfterMs);
    }
  }

  private restore(input: WikiTaskRuntimeState): void {
    const state = structuredClone(input);
    validateRestoredState(state);
    this.delegatedTasks = state.batches.reduce((total, batch) => total + batch.tasks.length, 0);
    this.delegateBatches = state.batches.length;
    for (const savedBatch of state.batches) {
      const records = new Map(savedBatch.tasks.map((saved) => [saved.task.id, createAsyncTask(saved)] as const));
      this.batches.set(savedBatch.batchId, { id: savedBatch.batchId, records });
      for (const saved of savedBatch.tasks) {
        if (saved.phase !== "terminal") continue;
        const output = terminalReceipt(saved).outputs.at(-1);
        if (output) this.contextArtifacts[output.nodeId] = output;
      }
    }
    for (const savedBatch of state.batches) {
      validateBatch(savedBatch.tasks.map((saved) => saved.task), this.options);
      for (const saved of savedBatch.tasks) {
        for (const ref of saved.task.contextRefs) {
          if (!Object.hasOwn(this.contextArtifacts, ref)) throw new Error(`Restored delegate task ${saved.task.id} requests undeclared context artifact: ${ref}`);
        }
      }
    }
  }

  private async transition(operation: () => Promise<void>): Promise<void> {
    this.assertStateHealthy();
    try { await operation(); }
    catch (error) { this.stateFailure ??= error; throw error; }
  }

  private assertStateHealthy(): void {
    if (this.stateFailure !== undefined) throw this.stateFailure;
  }

  private async execute(record: AsyncTask, batch: number, signal: AbortSignal): Promise<TaskExecutionOutcome> {
    const task = record.state.task;
    let lastFailure: WikiDelegateError | undefined;
    const acceptedOutputs = [...(record.state.partial?.outputs ?? [])];
    const acceptedCoverage = new Set(record.state.partial?.coverage ?? []);
    const acceptedGaps = [...(record.state.partial?.gaps ?? [])];
    const maxAttempts = this.transientRetries + 1;
    let attempt = record.state.phase === "running" ? record.state.attempt : record.state.attempt + 1;
    let resumeCurrentAttempt = record.state.phase === "running";
    for (; attempt <= maxAttempts; attempt += 1) {
      if (!resumeCurrentAttempt) {
        await this.transition(() => this.options.transitions.taskStarted(batch, task.id, {
          attempt,
          ...(record.state.partial ? { partial: record.state.partial } : {}),
        }));
        record.state.phase = "running";
        record.state.attempt = attempt;
        record.state.sessionFile = undefined;
      }
      resumeCurrentAttempt = false;
      let release: (() => void) | undefined;
      let latestTelemetry: WikiAgentTelemetry | undefined;
      const onTelemetry = async (checkpoint: WikiAgentTelemetry): Promise<void> => {
        latestTelemetry = checkpoint;
        if (checkpoint.sessionFile && checkpoint.sessionFile !== record.state.sessionFile) {
          await this.transition(() => this.options.transitions.taskStarted(batch, task.id, {
            attempt,
            sessionFile: checkpoint.sessionFile,
            ...(record.state.partial ? { partial: record.state.partial } : {}),
          }));
          record.state.sessionFile = checkpoint.sessionFile;
        }
        await this.fireProgress({
          batchId: batch,
          phase: "update",
          task,
          telemetry: checkpoint,
        });
      };
      try {
        release = await this.gate.acquire(signal);
        const startedTelemetry: WikiAgentTelemetry = {
          target: { kind: "task", batch, taskId: task.id },
          attempt,
          sampledAt: new Date((this.options.now ?? Date.now)()).toISOString(),
          activity: "starting",
          activeTools: [],
        };
        await this.fireProgress({ batchId: batch, phase: "start", task, telemetry: startedTelemetry });
        const result = await this.options.agent.run(task, this.contextFor(task, batch, attempt, signal, onTelemetry, record.state.sessionFile));
        const researchSignal = result.research;
        if (task.role === "research" && researchSignal && !task.sourceScopeIds[0]) {
          throw new WikiTaskExecutionError(
            "Research completion requires a Source scope",
            "schema",
            { partialMarkdown: result.markdown, coverage: result.coverage, gaps: result.gaps },
          );
        }
        const completion = task.role === "research" && researchSignal
          ? createWikiResearchCompletion(researchSignal, task.assignmentIds, task.sourceScopeIds[0])
          : undefined;
        if (task.role === "research" && !researchSignal) {
          throw new WikiTaskExecutionError(
            "Research leaf completed without wiki_research_finish",
            "schema",
            { partialMarkdown: result.markdown, coverage: result.coverage, gaps: result.gaps },
          );
        }
        if (task.role === "research" && completion) {
          const assigned = new Set(task.assignmentIds);
          const completed = completion.completedAssignmentIds;
          const invalid = new Set(completed).size !== completed.length
            || completed.some((id) => !assigned.has(id))
            || (completion.status === "complete" && (completed.length !== assigned.size || task.assignmentIds.some((id) => !completed.includes(id))))
            || completion.needsFollowup !== (completion.followups.length > 0)
            || (completion.status === "incomplete" && !completion.needsFollowup)
            || (result.status !== undefined && result.status !== completion.status)
            || completion.followups.some((followup) => followup.sourceScopeIds.some((scope) => !task.sourceScopeIds.includes(scope)));
          if (invalid) {
            throw new WikiTaskExecutionError(
              "Research completion does not match its durable contract",
              "schema",
              { partialMarkdown: result.markdown, coverage: result.coverage, gaps: result.gaps },
            );
          }
        }
        const output = await this.persist(task, batch, attempt, result.markdown);
        ingestEvidenceHandoff({
          artifact: output,
          markdown: result.markdown,
          contract: task,
          ...(completion ? { completedAssignmentIds: completion.completedAssignmentIds, followups: completion.followups } : {}),
        });
        const successReceipt = receipt(task, result.status ?? completion?.status ?? "complete", result.summary, [...acceptedOutputs, output], [...acceptedCoverage, ...(result.coverage ?? [])], [...acceptedGaps, ...(result.gaps ?? [])], undefined, attempt, result.review, completion);
        return { kind: "terminal", receipt: successReceipt, usage: result.usage ?? latestTelemetry?.usage, telemetry: latestTelemetry };
      } catch (error) {
        if (pauseInterruption(signal) !== undefined) throw error;
        let decision = decideWikiAgentAttempt({
          error,
          attempt,
          maxAttempts,
          aborted: signal.aborted,
          baseRetryDelayMs: this.baseRetryDelayMs,
          random: this.random,
        });
        let failure = decision.failure;
        lastFailure = failure;
        const partial = partialResult(error);
        if (partial.markdown) {
          try {
            acceptedOutputs.push(await this.persist(task, batch, attempt, partial.markdown));
            for (const value of partial.coverage ?? []) acceptedCoverage.add(value);
            acceptedGaps.push(...(partial.gaps ?? []));
            const partialState = { outputs: [...acceptedOutputs], coverage: [...acceptedCoverage], gaps: [...acceptedGaps] };
            await this.transition(() => this.options.transitions.taskStarted(batch, task.id, {
              attempt,
              ...(record.state.sessionFile ? { sessionFile: record.state.sessionFile } : {}),
              partial: partialState,
            }));
            record.state.partial = partialState;
          } catch (artifactError) {
            decision = decideWikiAgentAttempt({
              error: artifactError,
              attempt,
              maxAttempts,
              baseRetryDelayMs: this.baseRetryDelayMs,
              random: this.random,
            });
            failure = decision.failure;
          }
        }
        lastFailure = failure;
        if (failure.code === "quota" || failure.code === "usage_limit") {
          record.state.partial = { outputs: [...acceptedOutputs], coverage: [...acceptedCoverage], gaps: [...acceptedGaps] };
          return { kind: "paused", pause: failure };
        }
        if (decision.action !== "retry") {
          const status = acceptedOutputs.length > 0 || failure.code === "timeout" || failure.code === "context_exhausted"
            ? "incomplete"
            : "failed";
          const terminalReceipt = receipt(task, status, failure.message, acceptedOutputs, [...acceptedCoverage], acceptedGaps, failure, attempt);
          return { kind: "terminal", receipt: terminalReceipt, usage: latestTelemetry?.usage, telemetry: latestTelemetry };
        }
        if (failure.code === "rate_limit") this.gate.reportPressure(failure.retryAfterMs ?? this.baseRetryDelayMs);
        release?.();
        release = undefined;
        const delay = decision.delayMs!;
        await this.sleep(delay, signal);
      } finally {
        release?.();
      }
    }
    const fallbackReceipt = receipt(task, acceptedOutputs.length ? "incomplete" : "failed", lastFailure?.message ?? "Task failed", acceptedOutputs, [...acceptedCoverage], acceptedGaps, lastFailure, maxAttempts);
    return { kind: "terminal", receipt: fallbackReceipt };
  }

  private contextFor(
    task: WikiDelegateContract,
    batch: number,
    attempt: number,
    signal: AbortSignal,
    onTelemetry: (telemetry: WikiAgentTelemetry) => void | Promise<void>,
    sessionFile?: string,
  ): WikiLeafTaskContext {
    return {
      runId: this.options.runId,
      batch,
      attempt,
      contextArtifacts: Object.fromEntries(task.contextRefs.map((id) => [id, this.contextArtifacts[id]])),
      sessionFile,
      candidateWikiRoot: this.options.candidateWikiRoot,
      signal,
      onTelemetry,
      reportObservability: this.options.reportObservability,
    };
  }

  private async persist(task: WikiDelegateContract, batch: number, attempt: number, markdown: string): Promise<WikiArtifactRef> {
    try {
      return await this.options.artifactStore.write({
        runId: this.options.runId,
        nodeId: artifactNodeId(batch, task.id),
        attempt,
        kind: task.role === "research" ? "research-handoff" : task.role === "write" ? "write-handoff" : "review-handoff",
        scope: scopeForTask(task),
        content: markdown.endsWith("\n") ? markdown : `${markdown}\n`,
      });
    } catch (error) {
      throw new WikiTaskExecutionError("Could not persist task artifact", "artifact_io", { cause: error });
    }
  }

  private async fireProgress(event: WikiTaskProgressEvent): Promise<void> {
    try {
      await this.onTask?.(event);
    } catch {
      /* observability must not fail the task */
    }
  }
}

interface AsyncTask {
  state: WikiTaskRuntimeTaskState;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  launched: boolean;
  settled: boolean;
}

interface AsyncBatch {
  id: number;
  records: Map<string, AsyncTask>;
}

type TaskExecutionOutcome = {
  kind: "terminal";
  receipt: WikiDelegateReceipt;
  usage?: WikiContextStats;
  telemetry?: WikiAgentTelemetry;
} | {
  kind: "paused";
  pause?: WikiDelegateError;
};

function createAsyncTask(input: WikiTaskRuntimeTaskState): AsyncTask {
  const deferred = promiseWithResolvers<void>();
  const state = structuredClone(input);
  const settled = state.phase === "terminal";
  if (settled) deferred.resolve();
  return {
    state,
    controller: new AbortController(),
    done: deferred.promise,
    resolveDone: deferred.resolve,
    launched: state.phase === "terminal",
    settled,
  };
}

function resetAsyncTask(record: AsyncTask): void {
  const deferred = promiseWithResolvers<void>();
  record.done = deferred.promise;
  record.resolveDone = deferred.resolve;
  record.settled = false;
}

function settleAsyncTask(record: AsyncTask): void {
  if (record.settled) return;
  record.settled = true;
  record.resolveDone();
}

function terminalReceipt(state: WikiTaskRuntimeTaskState): WikiDelegateReceipt {
  if (state.phase !== "terminal" || !state.receipt) throw new Error(`Terminal task ${state.task.id} requires a receipt`);
  return state.receipt;
}

function promiseWithResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}

function validateRestoredState(state: WikiTaskRuntimeState): void {
  const batchIds = new Set<number>();
  for (const batch of state.batches) {
    if (!Number.isSafeInteger(batch.batchId) || batch.batchId < 1 || batchIds.has(batch.batchId)) throw new Error(`Invalid or duplicate restored batch id: ${batch.batchId}`);
    batchIds.add(batch.batchId);
    const taskIds = new Set<string>();
    for (const saved of batch.tasks) {
      artifactNodeId(batch.batchId, saved.task.id);
      if (taskIds.has(saved.task.id)) throw new Error(`Duplicate restored task id in batch ${batch.batchId}: ${saved.task.id}`);
      taskIds.add(saved.task.id);
      if (!Number.isInteger(saved.attempt) || saved.attempt < 0) throw new Error(`Invalid restored attempt for task ${saved.task.id}`);
      if ((saved.phase === "running" || saved.phase === "paused") && saved.attempt < 1) throw new Error(`${saved.phase} restored task ${saved.task.id} requires an attempt`);
      if (saved.phase === "terminal" && !saved.receipt) throw new Error(`Terminal restored task ${saved.task.id} requires a receipt`);
      if (saved.phase !== "terminal" && saved.receipt) throw new Error(`Non-terminal restored task ${saved.task.id} cannot have a receipt`);
      if (saved.phase !== "terminal" && saved.collected) throw new Error(`Non-terminal restored task ${saved.task.id} cannot be collected`);
      if (saved.phase !== "paused" && saved.pause) throw new Error(`Only paused restored task ${saved.task.id} may have pause details`);
      if (saved.receipt && (saved.receipt.id !== saved.task.id || saved.receipt.role !== saved.task.role)) {
        throw new Error(`Restored receipt identity does not match task ${saved.task.id}`);
      }
    }
  }
}

function receiptFromState(state: WikiTaskRuntimeTaskState, failure: WikiDelegateError): WikiDelegateReceipt {
  const partial = state.partial;
  const outputs = partial?.outputs ?? [];
  const status = outputs.length > 0 || failure.code === "timeout" || failure.code === "context_exhausted" ? "incomplete" : "failed";
  return receipt(state.task, status, failure.message, outputs, partial?.coverage ?? [], partial?.gaps ?? [], failure, Math.max(1, state.attempt));
}

function pauseInterruption(signal: AbortSignal): { pause?: WikiDelegateError } | undefined {
  if (!signal.aborted) return undefined;
  if (signal.reason instanceof WikiTaskPauseError) {
    return {
      pause: {
        code: signal.reason.reason,
        message: signal.reason.message,
        retryable: false,
        retryAfterMs: signal.reason.retryAfterMs,
      },
    };
  }
  return signal.reason === WIKI_MANUAL_PAUSE ? {} : undefined;
}

function artifactNodeId(batchId: number, taskId: string): string {
  const value = `b${batchId}-${taskId}`;
  if (value.length > 128) throw new Error(`Delegate task ${taskId} produces an oversized artifact handle`);
  return value;
}

function validateLimit(value: number, name: string): void {
  if (value !== Number.POSITIVE_INFINITY && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
}

function validateCollectOptions(options: { until: "any" | "all"; timeoutSeconds?: number }): void {
  if (options.until !== "any" && options.until !== "all") throw new Error("collect until must be any or all");
  if (options.timeoutSeconds === undefined) return;
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0) {
    throw new Error("collect timeoutSeconds must be a non-negative number");
  }
}

async function waitWithTimeout(completion: Promise<void>, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new WikiTaskExecutionError("Collect cancelled", "cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const timeout = timeoutMs === undefined
    ? undefined
    : new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  const aborted = signal && new Promise<void>((_resolve, reject) => {
    const onAbort = () => reject(new WikiTaskExecutionError("Collect cancelled", "cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    const racers: Array<Promise<void>> = [completion];
    if (timeout) racers.push(timeout);
    if (aborted) racers.push(aborted);
    await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

function validateBatch(tasks: readonly WikiDelegateContract[], options: WikiTaskRuntimeOptions): void {
  if (tasks.length === 0) throw new Error("Delegation requires at least one task");
  const ids = new Set<string>();
  const writes = new Set<string>();
  for (const task of tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.id) || ids.has(task.id)) throw new Error(`Invalid or duplicate delegate task id: ${task.id}`);
    ids.add(task.id);
    if (!task.instruction.trim()) throw new Error(`Delegate task ${task.id} requires an instruction`);
    for (const scope of task.sourceScopeIds) {
      if (!options.sourceScopes.includes(scope)) throw new Error(`Delegate task ${task.id} requests undeclared source scope: ${scope}`);
    }
    if (task.role === "write" && !task.writePaths?.length) throw new Error(`Write task ${task.id} requires writePaths`);
    if (task.role === "review" && !task.reviewPaths?.length) throw new Error(`Review task ${task.id} requires reviewPaths`);
    for (const value of task.writePaths ?? []) {
      const relative = typeof value === "string" && value.startsWith("wiki/") ? value.slice("wiki/".length) : undefined;
      if (!isSafeWikiPagePath(relative)) throw new Error(`Unsafe Wiki write path: ${value}`);
      if (writes.has(value)) throw new Error(`Delegate writePaths overlap within batch: ${value}`);
      writes.add(value);
    }
    for (const value of task.reviewPaths ?? []) {
      const relative = typeof value === "string" && value.startsWith("wiki/") ? value.slice("wiki/".length) : undefined;
      if (!isSafeWikiPagePath(relative)) throw new Error(`Unsafe Wiki review path: ${value}`);
    }
  }
}

function receipt(
  task: WikiDelegateContract,
  status: WikiDelegateReceipt["status"],
  summary: string,
  outputs: WikiArtifactRef[],
  coverage: string[] = [],
  gaps: WikiDelegateGap[] = [],
  failure?: WikiDelegateError,
  attempts = 1,
  review?: WikiReviewResult,
  research?: WikiResearchCompletion,
): WikiDelegateReceipt {
  const researchFollowupDrafts = task.role === "research"
    ? (research?.followups ?? (status === "incomplete" ? [{ kind: "tool_failure" as const, question: truncateUtf8(summary, 512), sourceScopeIds: task.sourceScopeIds }] : []))
    : [];
  const followups: WikiDelegateFollowup[] | undefined = task.role === "research"
    ? researchFollowupDrafts.map((followup) => ({ ...followup, id: canonicalWikiFollowupId(task.contractId, followup) }))
    : undefined;
  const completedAssignmentIds = task.role === "research"
    ? task.assignmentIds.filter((id) => research?.completedAssignmentIds.includes(id) ?? false)
    : undefined;
  return {
    id: task.id,
    role: task.role,
    status,
    summary: boundedDelegateSummary(summary),
    outputs,
    error: failure && { code: failure.code, message: failure.message, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs },
    attempts,
    contractId: task.contractId,
    contractDigest: task.contractDigest,
    ...(review ? { review } : {}),
    ...(coverage.length ? { coverage: [...coverage] } : {}),
    ...(gaps.length ? { gaps: structuredClone(gaps) } : {}),
    ...(task.role === "research" ? {
      completedAssignmentIds: [...(completedAssignmentIds ?? [])],
      needsFollowup: research?.needsFollowup ?? status === "incomplete",
      ...(followups ? { followups } : {}),
      domains: research?.domains ?? [],
    } : {}),
  };
}

function partialResult(error: unknown): { markdown?: string; coverage?: string[]; gaps?: WikiDelegateGap[] } {
  return error instanceof WikiTaskExecutionError ? {
    markdown: error.options.partialMarkdown,
    coverage: error.options.coverage,
    gaps: error.options.gaps,
  } : {};
}

function scopeForTask(task: WikiDelegateContract): string[] {
  return [...new Set([
    ...task.sourceScopeIds,
    ...(task.role === "research" ? task.domainScopeIds : []),
    ...(task.role === "research" ? task.lensScopeIds : []),
  ])];
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new WikiTaskExecutionError("Task cancelled", "cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new WikiTaskExecutionError("Task cancelled", "cancelled"));
    }, { once: true });
  });
}

export class WikiWritePathLease {
  private readonly active = new Set<string>();
  private readonly waiters: Array<{
    paths: string[];
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    onAbort: () => void;
  }> = [];

  async acquire(paths: readonly string[], signal: AbortSignal): Promise<() => void> {
    if (paths.length === 0) return () => {};
    if (signal.aborted) throw new WikiTaskExecutionError("Task cancelled", "cancelled");
    const requested = [...paths];
    if (this.available(requested)) return this.take(requested);
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = {
        paths: requested,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new WikiTaskExecutionError("Task cancelled", "cancelled"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  hasActive(): boolean {
    return this.active.size > 0;
  }

  assertReviewAllowed(): void {
    if (this.hasActive()) throw new Error("Wiki review is blocked while Wiki writes are active");
  }

  private available(paths: readonly string[]): boolean {
    return paths.every((path) => !this.active.has(path));
  }

  private take(paths: readonly string[]): () => void {
    for (const path of paths) this.active.add(path);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const path of paths) this.active.delete(path);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      if (!this.available(waiter.paths)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.take(waiter.paths));
    }
  }
}

class SharedAdmissionGate {
  private active = 0;
  private pressureUntil = 0;
  private readonly waiters: Array<{ resolve: (release: () => void) => void; signal: AbortSignal }> = [];

  constructor(private readonly normalLimit: number, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(normalLimit) || normalLimit < 1) throw new Error("concurrency must be a positive integer");
  }

  reportPressure(delayMs: number): void {
    this.pressureUntil = Math.max(this.pressureUntil, this.now() + Math.max(0, delayMs));
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new WikiTaskExecutionError("Task cancelled", "cancelled");
    if (this.active < this.limit()) return this.take();
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = { resolve, signal };
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new WikiTaskExecutionError("Task cancelled", "cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      waiter.resolve = (release) => {
        signal.removeEventListener("abort", abort);
        resolve(release);
      };
      this.waiters.push(waiter);
    });
  }

  private limit(): number { return this.now() < this.pressureUntil ? 1 : this.normalLimit; }
  private take(): () => void {
    this.active += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
      while (this.waiters.length && this.active < this.limit()) this.waiters.shift()!.resolve(this.take());
    };
  }
}
