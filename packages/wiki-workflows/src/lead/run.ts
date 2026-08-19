import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { renamePath, syncDirectory, writeText } from "../files.js";
import { assertContainedAbsolutePath } from "../path-policy.js";
import { createWikiArtifactStore } from "../artifact-store.js";
import {
  boundedDelegateSummary,
  createWikiDelegateContract,
  parseWikiDelegateTask,
  parseWikiDelegateContract,
  parseWikiDelegateError,
  parseWikiDelegateReceipt,
  parseWikiReviewBasis,
  projectWikiLeadSnapshot,
  WikiTaskPauseError,
  type WikiDelegateContract,
  type WikiDelegateReceipt,
  type WikiReviewBasis,
} from "../delegate-contracts.js";
import { decideWikiAgentTerminal } from "../failures.js";
import type { WikiAgentTarget, WikiAgentTelemetry } from "../producer-types.js";
import { emptyWikiLeadFacts, UnsupportedWikiRunVersionError, type WikiLeadFacts } from "../run-record.js";
import type { WikiLeadObservation, WikiLeadOutcome, WikiPinnedSourcePlan, WikiTaskRuntimeState } from "../runtime-types.js";
import type { WikiDelegateBatchSnapshot } from "../delegate-contracts.js";
import {
  WikiTaskRuntime,
  WikiWritePathLease,
  type WikiLeafAgent,
  type WikiTaskProgressEvent,
} from "../task-runtime.js";
import { finalizeWiki, materializeValidatedWikiIndexes, type WikiFinalizeFaultPoint } from "./finalize.js";
import { parseDelegateState } from "./delegates.js";
import { parseWikiSpec, wikiSpecClusterPaths, wikiSpecDomainId, wikiSpecDomainIds, wikiSpecRelativePath, wikiSpecSourceId, wikiSpecSourceIds, type WikiSpec } from "./spec.js";
import { resolvePinnedWikiRoots, type ResolvedWikiRoots } from "./indexes.js";
import { canonicalizeWikiPageContent, formatIssue, validateWikiPageContent } from "./validate.js";
import { parseWikiReviewResult, type WikiReviewResult } from "../delegate-contracts.js";
import {
  digestWikiTree,
  issueWikiPublicationSeal,
  WIKI_PUBLICATION_FORMAT,
  type WikiPublicationSeal,
} from "../wiki-publication-seal.js";
import { sameStringSet, stableStringify } from "../util.js";
import { projectWikiBoard, renderWikiBoard, researchTaxonomyDecisions, wikiLeadMayWrite, wikiOpenResearchBlockerIds, type WikiBoardNextAction, type WikiBoardProjectionInput, type WikiBoardTaxonomyCheckpoint, type WikiBoardTaxonomyDecision } from "./board.js";
import { assertDispatchable, clusterSourceScopeIds, contextRefsForSources, selectReadyClusters, type WikiDispatchTaskInput } from "./dispatch.js";
import { WikiRejectedError, allowedList, listed } from "../wiki-reject.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface AcceptedReview extends WikiReviewResult {
  contractId: string;
  contractDigest: string;
  basis: WikiReviewBasis;
}

/** Parsed Lead facts. Persistable as WikiLeadFacts; spec/taxonomy/reviews stay JSON-serializable. */
interface WikiLeadView {
  candidateRevision: number;
  specRevision: number;
  policyDigest: string;
  compactionObserved: boolean;
  sourceScopeIds: readonly string[];
  spec?: WikiSpec;
  taxonomy?: WikiBoardTaxonomyCheckpoint;
  reviews: AcceptedReview[];
  delegates: WikiTaskRuntimeState;
}

export interface WikiLeadSpecRecord {
  revision: number;
  spec: WikiSpec;
}

/** Host-resolved input read from the fixed discovery slot. It contains no authority IDs. */
export interface WikiDiscoveryPlanEntry {
  sourceScopeId: string;
  instruction: string;
}

export interface WikiQueuedWave {
  wave: "discovery" | "supplement" | "write" | "review";
  batchId: number;
  contracts: WikiDelegateContract[];
}

export interface WikiActiveWave {
  wave: "discovery" | "supplement" | "write" | "review";
  batchId: number;
}

export type WikiCandidateFaultPoint = "afterStage" | "afterState" | "afterRename" | "afterVerify";
export type WikiLeadFinalizeFaultPoint = "afterFinalizeJournal" | WikiFinalizeFaultPoint | "afterFinalize" | "afterSeal";

export interface WikiLeadRunOptions {
  workspace: string;
  runId: string;
  candidateWikiRoot: string;
  policy: unknown;
  requiredSections?: readonly string[];
  fault?: (point: WikiCandidateFaultPoint) => void | Promise<void>;
  finalizeFault?: (point: WikiLeadFinalizeFaultPoint) => void | Promise<void>;
  /** Authoritative lifecycle execution checked under the Lead lease before every operation. */
  assertActive: () => Promise<void>;
  executionToken: string;
  /** Persist the full Lead fact snapshot. The Run record is the only authority. */
  commitLead: (facts: WikiLeadFacts) => Promise<void>;
  /** Restore Lead facts from the Run record when present. */
  readLead?: () => Promise<WikiLeadFacts | undefined>;
  sourcePlan?: WikiPinnedSourcePlan;
  /** Host-owned source scope IDs used when a pinned source plan is unavailable. */
  allowedSourceScopeIds?: readonly string[];
  language?: "zh" | "en";
  /** Run-wide queue budget; admission/concurrency is enforced by WikiTaskRuntime. */
  maxDelegatedTasks?: number;
  requiredProfileCoverage?: readonly string[];
}

export interface WikiLeadHost {
  readonly compactionObserved: boolean;
  readonly hasDelegatedBatches: boolean;
  readonly nextAction: WikiBoardNextAction;
  readonly taxonomyCheckpoint: WikiBoardTaxonomyCheckpoint | undefined;
  readonly specRecord: WikiLeadSpecRecord | undefined;
  researchTaxonomyDecisions(): WikiBoardTaxonomyDecision[];
  startWave(discoveryPlan: readonly WikiDiscoveryPlanEntry[]): Promise<{ wave: WikiQueuedWave["wave"]; batchId: number }>;
  collect(options: { until: "any" | "all"; timeoutSeconds?: number }): Promise<ReturnType<typeof projectWikiLeadSnapshot>>;
  cancel(reasonCode?: string): Promise<ReturnType<typeof projectWikiLeadSnapshot>>;
  saveTaxonomy(value: unknown): Promise<WikiBoardTaxonomyCheckpoint>;
  saveSpec(value: unknown): Promise<{ revision: number; pages: string[]; directWriteAllowed: boolean }>;
  finish(summary: string): Promise<{ accepted: true }>;
  replacePage(input: { path: string; content: string; actor: "lead" | "writer" }): Promise<void>;
}

export interface WikiLeadSessionRequest {
  host: WikiLeadHost;
  signal: AbortSignal;
  attempt: number;
  onTelemetry: (telemetry: WikiAgentTelemetry) => void | Promise<void>;
  onHealth: (input: { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string }) => void | Promise<void>;
  onCompaction: () => Promise<void>;
}

export interface WikiLeadAgents {
  readonly leaf: WikiLeafAgent;
  runLeadSession(input: WikiLeadSessionRequest): Promise<void>;
  followUp?(message: string): Promise<void>;
}

export interface WikiLeadRunLoopOptions {
  signal: AbortSignal;
  record: (observation: WikiLeadObservation) => void | Promise<void>;
  concurrency?: number;
  maxDelegateBatches?: number;
  now?: () => number;
  attempt?: number;
}

interface PublicationFinalizationTransaction {
  version: typeof WIKI_PUBLICATION_FORMAT;
  runId: string;
  candidateRevision: number;
  policyDigest: string;
  preTreeDigest: string;
  publicationAt: string;
  requiredPaths: string[];
  requiredProfileCoverage: string[];
  preimageRoot: string;
}

interface TransitionContext {
  reviews: AcceptedReview[];
  currentTreeDigest: string;
  candidateRevision: number;
  policyDigest: string;
}

/** Run-scoped owner of WikiSpec, candidate revision, delegated contracts and review acceptance. */
export class WikiLeadRun {
  private chain = Promise.resolve();

  private constructor(
    private readonly workspace: string,
    readonly runId: string,
    readonly candidateWikiRoot: string,
    private readonly runRoot: string,
    private readonly requiredSections: readonly string[],
    private readonly fault: WikiLeadRunOptions["fault"],
    private readonly finalizeFault: WikiLeadRunOptions["finalizeFault"],
    private readonly assertActive: WikiLeadRunOptions["assertActive"],
    private readonly executionToken: string,
    private readonly commitLeadPersist: WikiLeadRunOptions["commitLead"],
    private readonly readLead: WikiLeadRunOptions["readLead"],
    private readonly pinnedRoots: ResolvedWikiRoots | undefined,
    private readonly maxDelegatedTasks: number | undefined,
    private readonly requiredProfileCoverage: readonly string[],
    private facts: WikiLeadView,
  ) {}

  static async open(options: WikiLeadRunOptions): Promise<WikiLeadRun> {
    if (!SAFE_RUN_ID.test(options.runId)) throw new Error("Invalid Wiki Lead run id");
    await assertExecutionActive(options.assertActive, options.executionToken);
    const workspace = path.resolve(options.workspace);
    const candidate = path.resolve(options.candidateWikiRoot);
    await mkdir(candidate, { recursive: true });
    await assertContainedAbsolutePath(workspace, candidate, false, "Wiki workspace");
    const runRoot = path.join(workspace, ".okf-wiki", "runs", options.runId);
    await mkdir(runRoot, { recursive: true });
    const policyDigest = hash(stableStringify(options.policy));
    const configuredSourceScopeIds = unique(options.sourcePlan?.sources.map((source) => source.scopeId) ?? options.allowedSourceScopeIds ?? []);
    const saved = options.readLead ? await options.readLead() : undefined;
    const hydrated = saved !== undefined && isInitializedLead(saved);
    const blank = emptyWikiLeadFacts(configuredSourceScopeIds);
    let facts: WikiLeadView = hydrated
      ? hydrateLeadFacts(saved, options.runId)
      : {
          candidateRevision: blank.candidateRevision,
          specRevision: blank.specRevision,
          policyDigest,
          compactionObserved: blank.compactionObserved,
          sourceScopeIds: [...blank.sourceScopeIds],
          reviews: [],
          delegates: blank.delegates,
        };
    if (hydrated && configuredSourceScopeIds.length && !sameStringSet(facts.sourceScopeIds, configuredSourceScopeIds)) {
      throw new Error("Pinned source scope IDs do not match the durable Wiki Lead run");
    }
    if (!facts.sourceScopeIds.length && configuredSourceScopeIds.length) facts = { ...facts, sourceScopeIds: configuredSourceScopeIds };
    const pinnedRoots = options.sourcePlan
      ? await resolvePinnedWikiRoots(options.sourcePlan, options.language ?? "en", candidateDirectory(workspace, candidate))
      : undefined;
    const subject = new WikiLeadRun(
      workspace, options.runId, candidate, runRoot, options.requiredSections ?? [],
      options.fault, options.finalizeFault, options.assertActive, options.executionToken,
      options.commitLead, options.readLead, pinnedRoots, options.maxDelegatedTasks,
      options.requiredProfileCoverage ?? [], facts,
    );
    await subject.serial(async () => {
      await subject.recover();
      if (subject.facts.policyDigest !== policyDigest) {
        subject.facts = { ...subject.facts, policyDigest, candidateRevision: subject.facts.candidateRevision + 1, reviews: [] };
      }
      // Re-materialize the host board on every reopen so a missing or stale projection cannot survive compaction.
      await subject.writeFacts(subject.facts);
    });
    return subject;
  }

  get specRecord(): WikiLeadSpecRecord | undefined {
    return this.facts.spec ? { revision: this.facts.specRevision, spec: structuredClone(this.facts.spec) } : undefined;
  }

  get taxonomyCheckpoint(): WikiBoardTaxonomyCheckpoint | undefined {
    return this.facts.taxonomy ? structuredClone(this.facts.taxonomy) : undefined;
  }

  researchTaxonomyDecisions(): WikiBoardTaxonomyDecision[] {
    return researchTaxonomyDecisions(this.facts.delegates.batches.flatMap((batch) => batch.tasks.map((task) => ({
      role: task.task.role,
      phase: task.phase,
      sourceScopeIds: task.task.sourceScopeIds,
      receipt: task.receipt,
    }))));
  }

  get nextAction() {
    return projectWikiBoard(boardInput(this.facts, this.runId)).nextAction;
  }

  get compactionObserved(): boolean { return this.facts.compactionObserved; }

  get taskRuntimeState(): WikiTaskRuntimeState { return structuredClone(this.facts.delegates); }

  /** Resolve the sole wave that model-facing collect/cancel controls may act on. */
  async currentActiveWave(): Promise<WikiActiveWave | undefined> {
    return await this.serial(async () => {
      await this.recover();
      const current = activeDelegateBatches(this.facts);
      if (current.length > 1) throw new Error("Wiki Run has multiple uncollected delegate waves");
      const batch = current[0];
      if (!batch) return undefined;
      return { batchId: batch.batchId, wave: batchWave(batch) };
    });
  }

  async saveTaxonomy(value: unknown): Promise<WikiBoardTaxonomyCheckpoint> {
    return await this.serial(async () => {
      await this.recover();
      if (this.facts.spec) throw new Error("Wiki taxonomy must be accepted before wiki_plan");
      assertResearchReady(this.facts);
      const inspected = inspectTaxonomyCheckpoint(value);
      const sourceDefects = inspected.checkpoint
        ? collectTaxonomySourceDefects(inspected.checkpoint, this.facts.sourceScopeIds)
        : [];
      if (inspected.defects.length || sourceDefects.length) {
        throw new WikiRejectedError([...inspected.defects, ...sourceDefects]);
      }
      const checkpoint = inspected.checkpoint!;
      if (this.facts.taxonomy && checkpoint.revision <= this.facts.taxonomy.revision) {
        throw new Error(`Wiki taxonomy revision must advance beyond ${this.facts.taxonomy.revision}`);
      }
      const next = { ...this.facts, taxonomy: checkpoint };
      await this.writeFacts(next);
      this.facts = next;
      return structuredClone(checkpoint);
    });
  }

  async saveSpec(specValue: unknown, expectedRevision = this.facts.specRevision): Promise<WikiLeadSpecRecord> {
    return await this.serial(async () => {
      await this.recover();
      if (!this.facts.taxonomy?.accepted) throw new Error("Accept a Wiki taxonomy checkpoint with wiki_taxonomy before wiki_plan");
      assertResearchReady(this.facts);
      if (expectedRevision !== this.facts.specRevision) throw new Error(`WikiSpec revision conflict: expected ${expectedRevision}, found ${this.facts.specRevision}`);
      const spec = parseWikiSpec(specValue);
      const ownership = collectTaxonomyOwnershipDefects(this.facts.taxonomy, spec, this.facts.sourceScopeIds);
      if (ownership.length) throw new WikiRejectedError(ownership);
      const next = { ...this.facts, spec, specRevision: this.facts.specRevision + 1, candidateRevision: this.facts.candidateRevision + 1, reviews: [] };
      await this.writeFacts(next);
      this.facts = next;
      await this.tryIndexes();
      return { revision: next.specRevision, spec: structuredClone(spec) };
    });
  }

  async observeCompaction(): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      if (this.facts.compactionObserved) return;
      this.facts = { ...this.facts, compactionObserved: true };
      await this.writeFacts(this.facts);
    });
  }

  async replacePage(input: { path: string; content: string; actor: "lead" | "writer" }): Promise<{ candidateRevision: number; digest: string }> {
    return await this.serial(async () => {
      await this.recover();
      const spec = this.requireSpec();
      const relative = stripWikiPrefix(input.path);
      if (!spec.pages.includes(relative)) throw new Error(`Wiki page is not declared by the current WikiSpec: ${input.path}`);
      if (input.actor === "lead" && !wikiLeadMayWrite(spec, this.facts.compactionObserved)) {
        throw new Error("Lead direct writing is disabled for this WikiSpec or after context compaction; delegate an exact-path writer");
      }
      const issues = await validateWikiPageContent(this.workspace, spec, relative, input.content, candidateDirectory(this.workspace, this.candidateWikiRoot), undefined, this.requiredSections, this.pinnedRoots);
      if (issues.length) throw new Error(`Wiki page validation failed before write: ${issues.map(formatIssue).join("; ")}`);
      const canonical = canonicalizeWikiPageContent(input.content);
      const target = path.join(this.candidateWikiRoot, ...relative.split("/"));
      await assertContainedAbsolutePath(this.candidateWikiRoot, target, true, "candidate Wiki");
      await assertRegularOrMissing(target);
      await mkdir(path.dirname(target), { recursive: true });
      const staged = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.candidate`);
      await writeDurableNew(staged, canonical);
      await this.fault?.("afterStage");
      const oldDigest = await fileDigest(target);
      const newDigest = hash(canonical);
      const nextFacts: WikiLeadView = { ...this.facts, candidateRevision: this.facts.candidateRevision + 1, reviews: [] };
      await this.writeFacts(nextFacts);
      this.facts = nextFacts;
      await this.fault?.("afterState");
      await renamePath(staged, target);
      await this.fault?.("afterRename");
      if (await fileDigest(target) !== newDigest) throw new WikiCandidateCorruptionError(`Candidate page digest mismatch after replacement: ${relative}`);
      await this.fault?.("afterVerify");
      await this.tryIndexes();
      return { candidateRevision: nextFacts.candidateRevision, digest: newDigest };
    });
  }

  /** Derive and atomically queue the unique next workflow wave from durable Run state. */
  async startNextReadyWave(discoveryPlan: readonly WikiDiscoveryPlanEntry[] = []): Promise<WikiQueuedWave> {
    return await this.serial(async () => {
      await this.recover();
      if (activeDelegateBatches(this.facts).length) {
        throw new Error("Collect or cancel the current Wiki wave before starting another");
      }
      const batchId = nextBatchId(this.facts);
      const derived = deriveNextWave(this.facts, batchId, discoveryPlan, this.runId);
      const queued = await this.queueResolvedWave(derived.tasks, batchId);
      return { wave: derived.wave, ...queued };
    });
  }

  private async queueResolvedWave(values: readonly WikiDispatchTaskInput[], forcedBatchId?: number): Promise<{ batchId: number; contracts: WikiDelegateContract[] }> {
    const batchId = forcedBatchId ?? nextBatchId(this.facts);
    const existingResearchTasks = projectExistingResearchTasks(this.facts);
    const dispatchTasks = values.map((task, index) => expandDispatchTask(task, this.facts.spec, existingResearchTasks, `a-b${batchId}-t${index + 1}`) as WikiDispatchTaskInput);
    assertDispatchable({
      tasks: dispatchTasks,
      spec: this.facts.spec,
      pendingWritePaths: pendingWritePaths(this.facts),
      knownContextRefs: knownContextRefs(this.facts),
      delegatedTasks: delegatedTaskCount(this.facts),
      delegateBatches: this.facts.delegates.batches.length,
      maxDelegatedTasks: this.maxDelegatedTasks,
      existingResearchTasks,
      knownResearchBlockerIds: wikiOpenResearchBlockerIds(this.facts.delegates.batches.flatMap((batch) => batch.tasks).map(researchBlockerTask)),
    });
    if ((values.some((value) => value.role === "write" || value.role === "review"))
      && (!this.facts.taxonomy?.accepted || !this.facts.spec || !researchReady(this.facts))) {
      throw new Error("Wiki write/review dispatch requires an accepted taxonomy, WikiSpec, and complete research wave");
    }
    const parsed = dispatchTasks.map((value) => {
      const { cluster: _cluster, ...contractInput } = value;
      return parseWikiDelegateTask(contractInput);
    });
    const reviewTree = parsed.some((task) => task.role === "review") ? await this.prepareReviewTree() : undefined;
    const contracts = parsed.map((task) => createWikiDelegateContract(
      batchId,
      task,
      task.role === "review" ? this.reviewBasis(task.reviewPaths, reviewTree!) : undefined,
    ));
    const batch = {
      batchId,
      tasks: contracts.map((task) => ({ task, phase: "queued" as const, attempt: 0, collected: false })),
    };
    const next = { ...this.facts, delegates: { batches: [...this.facts.delegates.batches, batch] } };
    await this.commitFacts(next);
    return { batchId, contracts: structuredClone(contracts) };
  }

  /** Remove a still-queued batch so a failed start can mint again. */
  async rollbackDelegateBatch(batchId: number): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const batchIndex = this.facts.delegates.batches.findIndex((batch) => batch.batchId === batchId);
      if (batchIndex < 0) throw new Error(`Unknown delegate batch: ${batchId}`);
      const batch = this.facts.delegates.batches[batchIndex];
      if (batch.tasks.some((task) => task.phase !== "queued" || task.attempt !== 0 || task.collected)) {
        throw new Error(`Cannot roll back delegate batch ${batchId} after launch`);
      }
      const batches = this.facts.delegates.batches.filter((_, index) => index !== batchIndex);
      await this.commitFacts({ ...this.facts, delegates: { batches } });
    });
  }

  async run(agents: WikiLeadAgents, options: WikiLeadRunLoopOptions): Promise<WikiLeadOutcome> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) controller.abort(options.signal.reason);
    const writeLease = new WikiWritePathLease();
    const artifactStore = createWikiArtifactStore({ workspace: this.workspace });
    let pause: WikiTaskPauseError | undefined;
    let finishSummary: string | undefined;
    const onTask = async (event: WikiTaskProgressEvent): Promise<void> => {
      const taskId = event.task.id;
      if (event.phase === "queued") {
        await options.record({ kind: "batch", phase: "queued", batch: event.batchId });
        return;
      }
      if (event.phase === "start") {
        await options.record({ kind: "batch", phase: "started", batch: event.batchId, taskId });
        return;
      }
      if (event.phase === "update" && event.telemetry) {
        await options.record({ kind: "telemetry", target: event.telemetry.target, telemetry: event.telemetry });
        return;
      }
      if (event.receipt) {
        const batch = this.facts.delegates.batches.find((entry) => entry.batchId === event.batchId);
        if (batch?.tasks.every((task) => task.phase === "terminal")) {
          await agents.followUp?.(`Wave ${event.batchId} settled. Re-read .okf-wiki/current/board.md before the next transition.`);
        }
      }
      await options.record({ kind: "batch", phase: "completed", batch: event.batchId, taskId });
    };
    const tasks = new WikiTaskRuntime({
      runId: this.runId,
      sourceScopes: [...this.facts.sourceScopeIds],
      candidateWikiRoot: this.candidateWikiRoot,
      artifactStore,
      agent: agents.leaf,
      concurrency: options.concurrency,
      maxDelegatedTasks: this.maxDelegatedTasks,
      maxDelegateBatches: options.maxDelegateBatches,
      restoredState: this.taskRuntimeState,
      onBatchQueued: (contracts) => this.commitBatchQueued(contracts),
      onTaskStarted: (batchId, taskId, input) => this.taskStarted(batchId, taskId, input),
      onTaskPaused: (batchId, taskId, input) => this.taskPaused(batchId, taskId, input),
      onTaskSettled: (batchId, taskId, input) => this.taskSettled(batchId, taskId, input),
      onTasksCollected: (batchId, taskIds) => this.tasksCollected(batchId, taskIds),
      writeLease,
      now: options.now,
      onTask,
      reportObservability: async (input) => await options.record({ kind: "health", ...input }),
    });
    const requireActiveWave = async (operation: "collect" | "cancel") => {
      const active = await this.currentActiveWave();
      if (!active) throw new Error(`No active Wiki wave to ${operation}`);
      return active;
    };
    const presentBatch = async (snapshot: WikiDelegateBatchSnapshot) => {
      return projectWikiLeadSnapshot(await this.presentSnapshot(snapshot));
    };
    const self = this;
    const host: WikiLeadHost = {
      get compactionObserved() { return self.compactionObserved; },
      get hasDelegatedBatches() { return self.taskRuntimeState.batches.length > 0; },
      get nextAction() { return self.nextAction; },
      get taxonomyCheckpoint() { return self.taxonomyCheckpoint; },
      get specRecord() { return self.specRecord; },
      researchTaxonomyDecisions: () => this.researchTaxonomyDecisions(),
      startWave: async (discoveryPlan) => {
        const queued = await this.startNextReadyWave(discoveryPlan);
        try {
          if (queued.wave === "review") writeLease.assertReviewAllowed();
          const started = await tasks.start(queued.contracts, controller.signal);
          if (started.batchId !== queued.batchId) {
            throw new Error(`TaskRuntime started batch ${started.batchId}, expected queued batch ${queued.batchId}`);
          }
          return { wave: queued.wave, batchId: started.batchId };
        } catch (error) {
          await this.rollbackDelegateBatch(queued.batchId);
          throw error;
        }
      },
      collect: async (collectOptions) => {
        const active = await requireActiveWave("collect");
        try {
          return await presentBatch(await tasks.collect(active.batchId, collectOptions, controller.signal));
        } catch (error) {
          if (error instanceof WikiTaskPauseError) {
            pause = error;
            controller.abort(error);
          }
          throw error;
        }
      },
      cancel: async (reasonCode) => {
        const active = await requireActiveWave("cancel");
        return await presentBatch(await tasks.cancel(active.batchId, undefined, reasonCode));
      },
      saveTaxonomy: async (value) => await this.saveTaxonomy(value),
      saveSpec: async (value) => {
        const specRecord = await this.saveSpec(value, this.specRecord?.revision ?? 0);
        return {
          revision: specRecord.revision,
          pages: specRecord.spec.pages,
          directWriteAllowed: wikiLeadMayWrite(specRecord.spec, this.compactionObserved),
        };
      },
      finish: async (summary) => {
        if (finishSummary) throw new Error("wiki_finish may be accepted only once");
        const defects: string[] = [];
        if (!summary.trim()) defects.push("wiki_finish requires a summary");
        if (!this.specRecord) defects.push("wiki_finish requires an accepted WikiSpec");
        try { tasks.assertFinishable(); }
        catch (error) {
          if (error instanceof WikiTaskPauseError) {
            pause = error;
            controller.abort(error);
            throw error;
          }
          if (error instanceof WikiRejectedError) defects.push(...error.defects);
          else throw error;
        }
        if (defects.length) throw new WikiRejectedError(defects);
        await this.finish(undefined, this.requiredProfileCoverage);
        finishSummary = boundedDelegateSummary(summary);
        return { accepted: true };
      },
      replacePage: async (input) => {
        const release = input.actor === "lead" ? await writeLease.acquire([input.path], controller.signal) : undefined;
        try { await this.replacePage(input); }
        finally { release?.(); }
      },
    };
    await tasks.resume(controller.signal);
    await options.record({ kind: "progress", message: "Wiki Lead is deciding adaptive research and writing tasks" });
    try {
      try {
        await agents.runLeadSession({
          host,
          signal: controller.signal,
          attempt: options.attempt ?? 1,
          onTelemetry: async (telemetry) => {
            await options.record({ kind: "telemetry", target: telemetry.target, telemetry });
          },
          onHealth: async (input) => await options.record({ kind: "health", ...input }),
          onCompaction: async () => { await this.observeCompaction(); },
        });
      } catch (error) {
        if (pause) {
          /* provider pause already recorded */
        } else {
          const decision = decideWikiAgentTerminal(error, options.signal.aborted);
          if (decision.action === "pause") {
            pause = new WikiTaskPauseError(
              decision.failure.code === "usage_limit" ? "usage_limit" : "quota",
              decision.failure.message,
              decision.failure.retryAfterMs,
            );
          } else {
            throw error;
          }
        }
      }
    } finally {
      options.signal.removeEventListener("abort", abort);
    }
    if (pause) {
      const retryAt = pause.retryAfterMs === undefined
        ? undefined
        : new Date((options.now ?? Date.now)() + pause.retryAfterMs).toISOString();
      await options.record({ kind: "progress", message: "Wiki Lead paused by provider" });
      return { kind: "pause", reason: pause.reason, summary: pause.message, retryAt };
    }
    if (!finishSummary) throw new Error("Lead agent completed without wiki_finish");
    await options.record({ kind: "progress", message: "Wiki Lead finished" });
    return { kind: "complete", summary: finishSummary };
  }

  private async commitBatchQueued(values: readonly WikiDelegateContract[]): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const contracts = values.map(parseWikiDelegateContract);
      if (!contracts.length || contracts.some((contract) => contract.batchId !== contracts[0].batchId)) throw new Error("Queued delegate contracts must belong to one batch");
      const saved = this.facts.delegates.batches.find((batch) => batch.batchId === contracts[0].batchId);
      if (!saved || saved.tasks.length !== contracts.length || saved.tasks.some((task, index) => task.phase !== "queued"
        || task.attempt !== 0 || task.collected || task.task.contractDigest !== contracts[index].contractDigest)) {
        throw new Error("Delegate batch must be durably queued by WikiLeadRun before launch");
      }
    });
  }

  async taskStarted(batchId: number, taskId: string, input: {
    attempt: number;
    sessionFile?: string;
    partial?: WikiTaskRuntimeState["batches"][number]["tasks"][number]["partial"];
  }): Promise<void> {
    await this.transitionTask(batchId, taskId, (current) => {
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error("Invalid delegate attempt");
      if (current.phase === "terminal") throw new Error(`Terminal delegate task cannot restart: ${taskId}`);
      if (input.attempt < current.attempt || input.attempt > current.attempt + 1) throw new Error(`Delegate attempt is not monotonic: ${taskId}`);
      if (current.phase === "paused" && input.attempt !== current.attempt) throw new Error(`Paused delegate task must resume its current attempt: ${taskId}`);
      return {
        ...current,
        phase: "running",
        attempt: input.attempt,
        collected: false,
        sessionFile: input.sessionFile,
        ...(input.partial ? { partial: structuredClone(input.partial) } : {}),
        pause: undefined,
        receipt: undefined,
      };
    });
  }

  async taskPaused(batchId: number, taskId: string, input: {
    attempt: number;
    pause?: WikiDelegateReceipt["error"];
    sessionFile?: string;
    partial?: WikiTaskRuntimeState["batches"][number]["tasks"][number]["partial"];
  }): Promise<void> {
    await this.transitionTask(batchId, taskId, (current) => {
      if (current.phase !== "running" || input.attempt !== current.attempt) throw new Error(`Only the current running attempt may pause: ${taskId}`);
      const pause = input.pause === undefined ? undefined : parseWikiDelegateError(input.pause);
      return {
        ...current,
        phase: "paused",
        collected: false,
        ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        ...(input.partial ? { partial: structuredClone(input.partial) } : {}),
        ...(pause ? { pause } : {}),
        receipt: undefined,
      };
    });
  }

  async taskSettled(batchId: number, taskId: string, input: {
    attempt: number;
    receipt: WikiDelegateReceipt;
    sessionFile?: string;
  }): Promise<void> {
    await this.transitionTask(batchId, taskId, (current, state) => {
      if (current.phase !== "running" || input.attempt !== current.attempt) throw new Error(`Only the current running attempt may settle: ${taskId}`);
      const contract = parseWikiDelegateContract(current.task);
      const receipt = parseWikiDelegateReceipt(input.receipt);
      assertReceiptForContract(receipt, contract, input.attempt, this.runId);
      const next = {
        ...current,
        phase: "terminal" as const,
        collected: false,
        receipt,
        ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        pause: undefined,
        partial: undefined,
      };
      if (contract.role === "review" && receipt.review && contract.reviewBasis) {
        const accepted = sameBasis(contract.reviewBasis, state, state.currentTreeDigest)
          && sameStringSet(receipt.review.reviewedPaths, contract.reviewPaths);
        state.reviews = state.reviews.filter((review) => review.contractId !== contract.contractId);
        if (accepted) state.reviews.push({
          ...structuredClone(receipt.review),
          contractId: contract.contractId,
          contractDigest: contract.contractDigest,
          basis: contract.reviewBasis,
        });
      }
      return next;
    });
  }

  async tasksCollected(batchId: number, taskIds: readonly string[]): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const unique = [...new Set(taskIds)];
      if (!unique.length) return;
      const batchIndex = this.facts.delegates.batches.findIndex((batch) => batch.batchId === batchId);
      if (batchIndex < 0) throw new Error(`Unknown delegate batch: ${batchId}`);
      const batch = this.facts.delegates.batches[batchIndex];
      const requested = new Set(unique);
      if (unique.some((taskId) => !batch.tasks.some((task) => task.task.id === taskId))) throw new Error(`Unknown delegate task in batch ${batchId}`);
      const tasks = batch.tasks.map((task) => {
        if (!requested.has(task.task.id)) return task;
        if (task.phase !== "terminal") throw new Error(`Only terminal delegate tasks may be collected: ${task.task.id}`);
        return task.collected ? task : { ...task, collected: true };
      });
      await this.commitFacts(replaceBatch(this.facts, batchIndex, { ...batch, tasks }));
    });
  }

  async finish(requiredPaths?: readonly string[], requiredProfileCoverage: readonly string[] = []): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const paths = requiredPaths ?? this.requireSpec().pages.map((page) => `wiki/${page}`);
      await this.assertPublishableAtTree(paths, requiredProfileCoverage, await digestWikiTree(this.candidateWikiRoot));
    });
  }

  async sealForPublication(input: {
    requiredPaths?: readonly string[];
    requiredProfileCoverage: readonly string[];
    publicationAt?: string;
    sourceFingerprint: string;
    summary: string;
  }): Promise<WikiPublicationSeal> {
    return await this.serial(async () => {
      await this.recover();
      const transaction = await this.preparePublicationFinalization(input);
      await restoreSafeTree(transaction.preimageRoot, this.candidateWikiRoot, transaction.preTreeDigest);
      await finalizeWiki(
        this.workspace,
        this.requireSpec(),
        candidateDirectory(this.workspace, this.candidateWikiRoot),
        transaction.publicationAt,
        this.requiredSections,
        { fault: async (point) => await this.finalizeFault?.(point), pinnedRoots: this.pinnedRoots },
      );
      await this.finalizeFault?.("afterFinalize");
      const seal = await issueWikiPublicationSeal({
        runId: this.runId,
        executionToken: this.executionToken,
        candidateRoot: this.candidateWikiRoot,
        pages: this.requireSpec().pages,
        spec: this.requireSpec(),
        sourceFingerprint: input.sourceFingerprint,
        summary: input.summary,
      });
      await this.finalizeFault?.("afterSeal");
      return seal;
    });
  }

  async presentSnapshot(snapshot: WikiDelegateBatchSnapshot): Promise<WikiDelegateBatchSnapshot> {
    return await this.serial(async () => {
      await this.recover();
      const tree = await digestWikiTree(this.candidateWikiRoot);
      return {
        ...snapshot,
        receipts: snapshot.receipts.map((receipt) => {
          if (receipt.role !== "review" || receipt.status !== "complete") return receipt;
          const accepted = this.facts.reviews.some((review) => review.contractId === receipt.contractId
            && review.contractDigest === receipt.contractDigest && sameBasis(review.basis, this.facts, tree));
          return accepted ? receipt : { ...receipt, status: "incomplete" as const, summary: "Review became stale while the delegated task was running", review: undefined };
        }),
      };
    });
  }

  private async prepareReviewTree(): Promise<string> {
    const spec = this.requireSpec();
    await materializeValidatedWikiIndexes(this.workspace, spec, candidateDirectory(this.workspace, this.candidateWikiRoot), undefined, this.requiredSections, this.pinnedRoots);
    return await digestWikiTree(this.candidateWikiRoot);
  }

  private reviewBasis(paths: readonly string[], treeDigest: string): WikiReviewBasis {
    const declared = new Set(this.requireSpec().pages.map((value) => `wiki/${value}`));
    const unique = [...new Set(paths)].sort();
    if (!unique.length || unique.some((value) => !declared.has(value))) throw new Error("Review paths must be non-empty and declared by the current WikiSpec");
    return { version: WIKI_PUBLICATION_FORMAT, candidateRevision: this.facts.candidateRevision, treeDigest, policyDigest: this.facts.policyDigest, paths: unique };
  }

  private async transitionTask(
    batchId: number,
    taskId: string,
    transition: (current: WikiTaskRuntimeState["batches"][number]["tasks"][number], context: TransitionContext) => WikiTaskRuntimeState["batches"][number]["tasks"][number],
  ): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const batchIndex = this.facts.delegates.batches.findIndex((batch) => batch.batchId === batchId);
      if (batchIndex < 0) throw new Error(`Unknown delegate batch: ${batchId}`);
      const batch = this.facts.delegates.batches[batchIndex];
      const taskIndex = batch.tasks.findIndex((task) => task.task.id === taskId);
      if (taskIndex < 0) throw new Error(`Unknown delegate task ${taskId} in batch ${batchId}`);
      const context: TransitionContext = {
        reviews: [...this.facts.reviews],
        currentTreeDigest: await digestWikiTree(this.candidateWikiRoot),
        candidateRevision: this.facts.candidateRevision,
        policyDigest: this.facts.policyDigest,
      };
      const nextTask = transition(structuredClone(batch.tasks[taskIndex]), context);
      const tasks = [...batch.tasks];
      tasks[taskIndex] = nextTask;
      const next = replaceBatch({ ...this.facts, reviews: context.reviews }, batchIndex, { ...batch, tasks });
      await this.commitFacts(next);
    });
  }

  private async assertPublishableAtTree(
    requiredPaths: readonly string[],
    requiredProfileCoverage: readonly string[],
    tree: string,
  ): Promise<void> {
    const board = projectWikiBoard(boardInput(this.facts, this.runId));
    const defects: string[] = [];
    const blocked = board.clusters.filter((cluster) => cluster.status === "blocked").map((cluster) => cluster.id);
    if (blocked.length) defects.push(`Wiki clusters blocked after 3 write/review attempts: ${listed(blocked)}`);
    const current = this.facts.reviews.filter((review) => sameBasis(review.basis, this.facts, tree));
    const requested = current.filter((review) => review.verdict === "changes_requested").map((review) => review.contractId);
    if (requested.length) defects.push(`Wiki review requested changes in contracts: ${listed(requested)}`);
    const covered = new Set(current.filter((review) => review.verdict === "pass").flatMap((review) => review.reviewedPaths));
    const missing = requiredPaths.filter((page) => !covered.has(page));
    if (missing.length) defects.push(`Current Wiki revision lacks passing independent review for: ${listed(missing)}`);
    const profile = new Set(current.filter((review) => review.verdict === "pass").flatMap((review) => review.profileCoverage));
    const missingProfile = requiredProfileCoverage.filter((item) => !profile.has(item));
    if (missingProfile.length) defects.push(`Current Wiki review does not cover profile requirements: ${listed(missingProfile)}`);
    if (defects.length) throw new WikiRejectedError(defects);
  }

  private async preparePublicationFinalization(input: {
    requiredPaths?: readonly string[];
    requiredProfileCoverage: readonly string[];
    publicationAt?: string;
  }): Promise<PublicationFinalizationTransaction> {
    const runRoot = this.runRoot;
    const transactionFile = path.join(runRoot, "publication-finalization.json");
    const requiredPaths = input.requiredPaths ?? this.requireSpec().pages.map((page) => `wiki/${page}`);
    const saved = await readPublicationTransaction(transactionFile, this.runId);
    if (saved) {
      if (path.resolve(saved.preimageRoot) !== path.join(runRoot, "publication-preimage")) throw new Error("Publication preimage path is not run-owned");
      if (saved.candidateRevision !== this.facts.candidateRevision || saved.policyDigest !== this.facts.policyDigest
        || !sameStringSet(saved.requiredPaths, requiredPaths)
        || !sameStringSet(saved.requiredProfileCoverage, input.requiredProfileCoverage)
        || input.publicationAt !== undefined && input.publicationAt !== saved.publicationAt) {
        throw new Error("Publication finalization request no longer matches the reviewed Candidate Revision");
      }
      await this.assertPublishableAtTree(saved.requiredPaths, saved.requiredProfileCoverage, saved.preTreeDigest);
      if (await digestWikiTree(saved.preimageRoot) !== saved.preTreeDigest) throw new WikiCandidateCorruptionError("Publication preimage was modified");
      return saved;
    }
    const preTreeDigest = await digestWikiTree(this.candidateWikiRoot);
    await this.assertPublishableAtTree(requiredPaths, input.requiredProfileCoverage, preTreeDigest);
    const preimageRoot = path.join(runRoot, "publication-preimage");
    await rm(preimageRoot, { recursive: true, force: true });
    await copySafeTree(this.candidateWikiRoot, preimageRoot);
    if (await digestWikiTree(preimageRoot) !== preTreeDigest) throw new WikiCandidateCorruptionError("Publication preimage digest mismatch");
    const transaction: PublicationFinalizationTransaction = {
      version: WIKI_PUBLICATION_FORMAT,
      runId: this.runId,
      candidateRevision: this.facts.candidateRevision,
      policyDigest: this.facts.policyDigest,
      preTreeDigest,
      publicationAt: input.publicationAt ?? new Date().toISOString(),
      requiredPaths: [...new Set(requiredPaths)].sort(),
      requiredProfileCoverage: [...new Set(input.requiredProfileCoverage)].sort(),
      preimageRoot,
    };
    await writeText(transactionFile, `${JSON.stringify(transaction, null, 2)}\n`);
    await this.finalizeFault?.("afterFinalizeJournal");
    return transaction;
  }

  private async recover(): Promise<void> {
    if (!this.readLead) return;
    const saved = await this.readLead();
    if (saved && isInitializedLead(saved)) this.facts = hydrateLeadFacts(saved, this.runId);
  }

  private async tryIndexes(): Promise<void> {
    if (!this.facts.spec) return;
    try { await materializeValidatedWikiIndexes(this.workspace, this.facts.spec, candidateDirectory(this.workspace, this.candidateWikiRoot), undefined, this.requiredSections, this.pinnedRoots); } catch { /* incomplete candidates have no indexes yet */ }
  }

  private requireSpec(): WikiSpec {
    if (!this.facts.spec) throw new Error("Submit an accepted WikiSpec with wiki_plan before writing or reviewing Wiki pages");
    return this.facts.spec;
  }

  private async commitFacts(next: WikiLeadView): Promise<void> {
    const parsed = hydrateLeadFacts(next, this.runId);
    await this.writeFacts(parsed);
    this.facts = parsed;
  }

  private async writeFacts(facts: WikiLeadView): Promise<void> {
    await this.commitLeadPersist(facts);
    await writeText(path.join(this.runRoot, "board.md"), renderWikiBoard(projectWikiBoard(boardInput(facts, this.runId))));
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const next = this.chain.catch(() => {}).then(async () => {
      await assertExecutionActive(this.assertActive, this.executionToken);
      result = await operation();
    });
    this.chain = next.catch(() => {});
    await next;
    return result;
  }
}

async function assertExecutionActive(assertActive: WikiLeadRunOptions["assertActive"], executionToken: string): Promise<void> {
  if (typeof assertActive !== "function" || typeof executionToken !== "string" || !executionToken.trim()) {
    throw new WikiLeadExecutionFencedError("Invalid Wiki Lead execution fence");
  }
  try {
    await assertActive();
  } catch (error) {
    if (error instanceof WikiLeadExecutionFencedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WikiLeadExecutionFencedError(message);
  }
}

export class WikiCandidateCorruptionError extends Error {
  constructor(message: string) { super(message); this.name = "WikiCandidateCorruptionError"; }
}

export class WikiLeadExecutionFencedError extends Error {
  constructor(message: string) { super(message); this.name = "WikiLeadExecutionFencedError"; }
}

const EMPTY_POLICY_DIGEST = "0".repeat(64);

function isInitializedLead(facts: WikiLeadFacts): boolean {
  return facts.policyDigest !== EMPTY_POLICY_DIGEST
    || facts.sourceScopeIds.length > 0
    || facts.specRevision > 0
    || facts.candidateRevision > 0
    || facts.delegates.batches.length > 0
    || facts.reviews.length > 0
    || facts.compactionObserved
    || facts.spec !== undefined
    || facts.taxonomy !== undefined;
}

function hydrateLeadFacts(facts: WikiLeadFacts, runId: string): WikiLeadView {
  if (!Number.isSafeInteger(facts.candidateRevision) || facts.candidateRevision < 0
    || !Number.isSafeInteger(facts.specRevision) || facts.specRevision < 0
    || typeof facts.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(facts.policyDigest)
    || typeof facts.compactionObserved !== "boolean"
    || facts.sourceScopeIds.some((id) => typeof id !== "string" || !id)
    || new Set(facts.sourceScopeIds).size !== facts.sourceScopeIds.length
    || (facts.spec === undefined) !== (facts.specRevision === 0)) {
    throw new Error(`Invalid Wiki Lead run state for ${runId}`);
  }
  return {
    candidateRevision: facts.candidateRevision,
    specRevision: facts.specRevision,
    policyDigest: facts.policyDigest,
    compactionObserved: facts.compactionObserved,
    sourceScopeIds: [...facts.sourceScopeIds],
    ...(facts.spec ? { spec: parseWikiSpec(facts.spec) } : {}),
    ...(facts.taxonomy ? { taxonomy: parseTaxonomyCheckpoint(facts.taxonomy) } : {}),
    reviews: facts.reviews.map(parseAcceptedReview),
    delegates: parseDelegateState(facts.delegates),
  };
}

function parseTaxonomyCheckpoint(value: unknown): WikiBoardTaxonomyCheckpoint {
  const inspected = inspectTaxonomyCheckpoint(value);
  if (inspected.defects.length) throw new WikiRejectedError(inspected.defects);
  return inspected.checkpoint!;
}

function inspectTaxonomyCheckpoint(value: unknown): { defects: string[]; checkpoint?: WikiBoardTaxonomyCheckpoint } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { defects: ["taxonomy must be a mapping"] };
  }
  const raw = value as Record<string, unknown>;
  const defects: string[] = [];
  const extras = Object.keys(raw).filter((key) => !["accepted", "revision", "decisions", "conflictIds", "digest"].includes(key));
  if (extras.length) defects.push(`taxonomy has unknown fields: ${listed(extras)}`);
  if (raw.accepted !== undefined && raw.accepted !== true) defects.push("taxonomy accepted must be true");
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) defects.push("taxonomy revision must be a positive integer");
  if (!Array.isArray(raw.decisions)) defects.push("taxonomy decisions must be an array");
  else if (raw.decisions.length === 0) defects.push("taxonomy decisions must not be empty");
  if (!Array.isArray(raw.conflictIds)) defects.push("taxonomy conflictIds must be an array");
  const decisions: WikiBoardTaxonomyDecision[] = [];
  if (Array.isArray(raw.decisions)) {
    for (const [index, entry] of raw.decisions.entries()) {
      const field = `taxonomy.decisions[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        defects.push(`${field} must be a mapping`);
        continue;
      }
      const decision = entry as Record<string, unknown>;
      const unknown = Object.keys(decision).filter((key) => !["sourceScopeId", "domainId", "conceptIds"].includes(key));
      if (unknown.length) defects.push(`${field} has unknown fields: ${listed(unknown)}`);
      if (typeof decision.sourceScopeId !== "string" || !decision.sourceScopeId) defects.push(`${field}.sourceScopeId must be a nonempty string`);
      if (typeof decision.domainId !== "string" || !decision.domainId) defects.push(`${field}.domainId must be a nonempty string`);
      if (!Array.isArray(decision.conceptIds) || decision.conceptIds.some((id) => typeof id !== "string" || !id)) {
        defects.push(`${field}.conceptIds must be an array of nonempty strings`);
        continue;
      }
      if (typeof decision.sourceScopeId === "string" && decision.sourceScopeId && typeof decision.domainId === "string" && decision.domainId) {
        decisions.push({
          sourceScopeId: decision.sourceScopeId,
          domainId: decision.domainId,
          conceptIds: [...decision.conceptIds],
        });
      }
    }
  }
  const conflictIds: string[] = [];
  if (Array.isArray(raw.conflictIds)) {
    for (const [index, id] of raw.conflictIds.entries()) {
      if (typeof id !== "string" || !id) defects.push(`taxonomy.conflictIds[${index}] must be a nonempty string`);
      else conflictIds.push(id);
    }
  }
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) return { defects };
  const body = { revision: raw.revision, decisions, conflictIds };
  const digest = raw.digest === undefined ? hash(stableStringify(body)) : raw.digest;
  if (typeof digest !== "string" || digest !== hash(stableStringify(body))) {
    defects.push("taxonomy digest mismatch");
    return { defects };
  }
  return {
    defects,
    checkpoint: { accepted: true, revision: raw.revision as number, decisions, conflictIds, digest },
  };
}

function collectTaxonomySourceDefects(checkpoint: WikiBoardTaxonomyCheckpoint, allowedSourceScopeIds: readonly string[]): string[] {
  const allowed = new Set(allowedSourceScopeIds);
  const undeclared = [...new Set(checkpoint.decisions.map((decision) => decision.sourceScopeId).filter((scope) => !allowed.has(scope)))];
  const covered = new Set(checkpoint.decisions.map((decision) => decision.sourceScopeId));
  const missing = allowedSourceScopeIds.filter((sourceScopeId) => !covered.has(sourceScopeId));
  const defects: string[] = [];
  if (undeclared.length) {
    defects.push(`taxonomy scopes outside pinned sources: ${listed(undeclared)} (allowed: ${allowedList(allowedSourceScopeIds)})`);
  }
  if (missing.length) defects.push(`Wiki taxonomy must cover every pinned Source: ${listed(missing)}`);
  return defects;
}

function collectTaxonomyOwnershipDefects(
  checkpoint: WikiBoardTaxonomyCheckpoint,
  spec: WikiSpec,
  allowedSourceScopeIds: readonly string[],
): string[] {
  const defects = collectTaxonomySourceDefects(checkpoint, allowedSourceScopeIds);
  const specSourceIds = wikiSpecSourceIds(spec);
  const unownedDomains: string[] = [];
  const unownedConcepts: string[] = [];
  for (const decision of checkpoint.decisions) {
    const ownedSources = specSourceIds.includes(decision.sourceScopeId) ? [decision.sourceScopeId] : [];
    if (!ownedSources.some((sourceId) => wikiSpecDomainIds(spec, sourceId).includes(decision.domainId))) {
      unownedDomains.push(`${decision.sourceScopeId}/${decision.domainId}`);
    }
    const concepts = new Set(spec.pages.flatMap((page) => {
      if (!ownedSources.includes(wikiSpecSourceId(page) ?? "") || wikiSpecDomainId(page) !== decision.domainId) return [];
      const segments = page.split("/");
      return segments.length >= 4 ? [segments[2]] : [];
    }));
    for (const conceptId of decision.conceptIds) {
      if (!concepts.has(conceptId)) unownedConcepts.push(`${decision.sourceScopeId}/${decision.domainId}/${conceptId}`);
    }
  }
  if (unownedDomains.length) defects.push(`taxonomy domains not owned by their source: ${listed(unownedDomains)}`);
  if (unownedConcepts.length) defects.push(`taxonomy concepts not owned by their domain: ${listed(unownedConcepts)}`);
  return defects;
}

function assertResearchReady(state: WikiLeadView): void {
  if (!researchReady(state)) throw new Error("Wiki taxonomy cannot be planned until the discovery research wave is complete");
}

function researchReady(state: WikiLeadView): boolean {
  const research = state.delegates.batches.flatMap((batch) => batch.tasks).filter((task) => task.task.role === "research");
  const discovery = research.filter((task) => task.task.role === "research" && task.task.mode === "discovery");
  if (!discovery.length) return false;
  const discoveryAssignments = new Set(discovery.flatMap((task) => task.task.role === "research" ? task.task.assignmentIds : []));
  if (!discoveryAssignments.size) return false;
  const coveredSources = new Set(discovery.flatMap((task) => task.task.sourceScopeIds));
  if (state.sourceScopeIds.some((sourceScopeId) => !coveredSources.has(sourceScopeId))) return false;
  const completedAssignments = new Set(research
    .filter((task) => task.phase === "terminal")
    .flatMap((task) => task.receipt?.completedAssignmentIds ?? []));
  return [...discoveryAssignments].every((id) => completedAssignments.has(id))
    && wikiOpenResearchBlockerIds(research.map(researchBlockerTask)).length === 0;
}

function researchBlockerTask(task: WikiTaskRuntimeState["batches"][number]["tasks"][number]) {
  const base = { id: task.task.id, role: task.task.role, phase: task.phase, ...(task.receipt ? { receipt: task.receipt } : {}) };
  return task.task.role === "research" ? { ...base, mode: task.task.mode, resolvesIds: task.task.resolvesIds } : base;
}

function nextBatchId(state: WikiLeadView): number {
  const batchId = state.delegates.batches.reduce((maximum, batch) => Math.max(maximum, batch.batchId + 1), 1);
  if (!Number.isSafeInteger(batchId)) throw new Error("Delegate batch identity is exhausted");
  return batchId;
}

function activeDelegateBatches(state: WikiLeadView): WikiTaskRuntimeState["batches"] {
  return state.delegates.batches.filter((batch) => batch.tasks.some((task) => !task.collected));
}

function batchWave(batch: WikiTaskRuntimeState["batches"][number]): WikiActiveWave["wave"] {
  const first = batch.tasks[0]?.task;
  if (!first) throw new Error(`Wiki delegate batch ${batch.batchId} has no tasks`);
  if (first.role === "write" || first.role === "review") return first.role;
  return first.mode === "supplement" ? "supplement" : "discovery";
}

function projectExistingResearchTasks(state: WikiLeadView) {
  return state.delegates.batches.flatMap((batch) => batch.tasks)
    .filter((item) => item.task.role === "research")
    .map((item) => {
      const task = item.task;
      if (task.role !== "research") throw new Error("Internal research task projection mismatch");
      const receipt = item.receipt;
      return {
        id: task.id,
        mode: task.mode,
        assignmentIds: task.assignmentIds,
        resolvesIds: task.resolvesIds,
        ...(receipt ? { receipt: {
          status: receipt.status,
          ...(receipt.error ? { error: { code: receipt.error.code } } : {}),
          ...(receipt.gaps ? { gaps: receipt.gaps } : {}),
          ...(receipt.followups ? { followups: receipt.followups.map((followup) => ({ id: followup.id })) } : {}),
        } } : {}),
      };
    });
}

function deriveNextWave(
  facts: WikiLeadView,
  batchId: number,
  discoveryPlan: readonly WikiDiscoveryPlanEntry[],
  runId: string,
): { wave: WikiQueuedWave["wave"]; tasks: WikiDispatchTaskInput[] } {
  const research = facts.delegates.batches.flatMap((batch) => batch.tasks).filter((task) => task.task.role === "research");
  const artifacts = knownContextRefs(facts);
  const board = projectWikiBoard(boardInput(facts, runId));
  if (board.nextAction === "discovery") {
    const entries = validateDiscoveryPlan(discoveryPlan, facts.sourceScopeIds);
    return {
      wave: "discovery",
      tasks: entries.map((entry, index) => ({
        id: `research-b${batchId}-t${index + 1}`,
        role: "research",
        instruction: entry.instruction,
        sourceScopeIds: [entry.sourceScopeId],
        contextRefs: [],
        mode: "discovery",
        domainScopeIds: [],
        lensScopeIds: [],
        resolvesIds: [],
      })),
    };
  }
  if (discoveryPlan.length) throw new Error("Discovery input is accepted only for the first Wiki wave");

  const blockers = wikiOpenResearchBlockerIds(research.map(researchBlockerTask));
  if (board.nextAction === "supplement") {
    const grouped = new Map<string, { blockers: string[]; relevant: typeof research }>();
    for (const blocker of blockers) {
      const owner = research.find((task) => task.task.role === "research" && blockerBelongsToTask(blocker, task));
      if (!owner || owner.task.role !== "research") continue;
      const source = owner.task.sourceScopeIds[0];
      if (!source) continue;
      const entry = grouped.get(source) ?? { blockers: [], relevant: [] };
      entry.blockers.push(blocker);
      if (!entry.relevant.includes(owner)) entry.relevant.push(owner);
      grouped.set(source, entry);
    }
    const sources = unique([...facts.sourceScopeIds.filter((source) => grouped.has(source)), ...grouped.keys()]);
    return {
      wave: "supplement",
      tasks: sources.map((source, index) => {
        const { blockers: sourceBlockers, relevant } = grouped.get(source)!;
        return {
          id: `research-b${batchId}-t${index + 1}`,
          role: "research",
          instruction: supplementInstruction(sourceBlockers, relevant),
          sourceScopeIds: [source],
          contextRefs: contextRefsForSources([source], artifacts),
          mode: "supplement",
          domainScopeIds: unique(relevant.flatMap((task) => task.task.role === "research" ? task.task.domainScopeIds : [])),
          lensScopeIds: unique(relevant.flatMap((task) => task.task.role === "research" ? task.task.lensScopeIds : [])),
          resolvesIds: sourceBlockers,
        };
      }),
    };
  }
  if (!researchReady(facts)) throw new Error("The discovery research wave is not complete");
  if (board.nextAction === "taxonomy") throw new Error("Accept the prepared taxonomy before starting the next Wiki wave");
  if (board.nextAction === "plan") throw new Error("Accept the prepared WikiSpec before starting the next Wiki wave");
  if (board.nextAction === "blocked") {
    const blocked = board.clusters.find((cluster) => cluster.nextStep === "blocked");
    throw new Error(`Wiki cluster is blocked after 3 write/review attempts: ${blocked?.id ?? "unknown"}`);
  }
  if (board.nextAction === "write" || board.nextAction === "review") {
    const wave = board.nextAction;
    const ready = selectReadyClusters(board.clusters, wave);
    return {
      wave,
      tasks: ready.map((cluster, index) => {
        const sourceScopeIds = clusterSourceScopeIds(cluster.id, facts.sourceScopeIds);
        return {
          id: `${wave}-b${batchId}-t${index + 1}`,
          role: wave,
          instruction: wave === "write"
            ? "Write every page in the assigned accepted WikiSpec cluster using grounded source evidence."
            : "Independently review every assigned page against the accepted WikiSpec, source evidence, and generation policy.",
          cluster: cluster.id,
          sourceScopeIds,
          contextRefs: contextRefsForSources(sourceScopeIds, artifacts),
        };
      }),
    };
  }
  throw new Error("No Wiki delegate wave is ready; finish the accepted Run");
}

function validateDiscoveryPlan(entries: readonly WikiDiscoveryPlanEntry[], sourceScopeIds: readonly string[]): WikiDiscoveryPlanEntry[] {
  if (!entries.length) throw new Error("The first Wiki wave requires a host-resolved discovery plan");
  const allowed = new Set(sourceScopeIds);
  const covered = new Set<string>();
  const parsed = entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Invalid discovery plan entry ${index + 1}`);
    if (!allowed.has(entry.sourceScopeId)) throw new Error(`Discovery plan references undeclared source scope: ${entry.sourceScopeId}`);
    if (typeof entry.instruction !== "string" || !entry.instruction.trim()) throw new Error(`Discovery plan entry ${index + 1} has an empty instruction`);
    covered.add(entry.sourceScopeId);
    return { sourceScopeId: entry.sourceScopeId, instruction: entry.instruction.trim() };
  });
  const missing = sourceScopeIds.filter((scope) => !covered.has(scope));
  if (missing.length) throw new Error(`Discovery plan must cover every pinned Source: ${missing.join(", ")}`);
  return parsed;
}

function blockerBelongsToTask(blocker: string, task: WikiTaskRuntimeState["batches"][number]["tasks"][number]): boolean {
  if (blocker.startsWith(`failure:${task.task.id}:`) || blocker.startsWith(`gap:${task.task.id}:`)) return true;
  return task.receipt?.followups?.some((followup) => followup.id === blocker) ?? false;
}

function supplementInstruction(
  blockers: readonly string[],
  tasks: readonly WikiTaskRuntimeState["batches"][number]["tasks"][number][],
): string {
  const questions = unique(blockers.flatMap((blocker) => tasks.flatMap((task) => blockerQuestion(blocker, task))));
  if (!questions.length) throw new Error("Open research blockers have no human-readable question or gap");
  return ["Answer only these research blockers with locators:", ...questions.map((question) => `- ${question}`), "Finish complete with empty followups once they are answered."].join("\n");
}

function blockerQuestion(blocker: string, task: WikiTaskRuntimeState["batches"][number]["tasks"][number]): string[] {
  const receipt = task.receipt;
  if (!receipt) return [];
  const gapPrefix = `gap:${task.task.id}:`;
  if (blocker.startsWith(gapPrefix)) {
    const index = Number.parseInt(blocker.slice(gapPrefix.length), 10) - 1;
    const question = receipt.gaps?.[index]?.question;
    return question ? [question] : [];
  }
  const followup = receipt.followups?.find((item) => item.id === blocker);
  if (followup) return [followup.question];
  if (blocker.startsWith(`failure:${task.task.id}:`) && receipt.error) {
    return [`The prior research failed: ${receipt.error.message}`];
  }
  return [];
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

function parseAcceptedReview(value: unknown): AcceptedReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid accepted Wiki review");
  const raw = value as Record<string, unknown>;
  const result = parseWikiReviewResult(Object.fromEntries(Object.entries(raw).filter(([key]) => ["verdict", "reviewedPaths", "findings", "profileCoverage"].includes(key))));
  const basis = parseWikiReviewBasis(raw.basis);
  if (Object.keys(raw).some((key) => !["verdict", "reviewedPaths", "findings", "profileCoverage", "contractId", "contractDigest", "basis"].includes(key))
    || typeof raw.contractId !== "string" || typeof raw.contractDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.contractDigest)
    || !sameStringSet(basis.paths, result.reviewedPaths)) throw new Error("Invalid accepted Wiki review");
  return { ...result, contractId: raw.contractId, contractDigest: raw.contractDigest, basis };
}

async function readPublicationTransaction(location: string, runId: string): Promise<PublicationFinalizationTransaction | undefined> {
  try {
    const raw = JSON.parse(await readFile(location, "utf8")) as Record<string, unknown>;
    const allowed = ["version", "runId", "candidateRevision", "policyDigest", "preTreeDigest", "publicationAt", "requiredPaths", "requiredProfileCoverage", "preimageRoot"];
    if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error("Invalid Wiki publication finalization transaction");
    if (raw.version !== WIKI_PUBLICATION_FORMAT) throw new UnsupportedWikiRunVersionError(`runs/${runId}/publication-finalization.json`, raw.version, WIKI_PUBLICATION_FORMAT);
    if (raw.runId !== runId
      || !Number.isSafeInteger(raw.candidateRevision) || (raw.candidateRevision as number) < 0
      || typeof raw.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.policyDigest)
      || typeof raw.preTreeDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.preTreeDigest)
      || typeof raw.publicationAt !== "string" || typeof raw.preimageRoot !== "string"
      || !Array.isArray(raw.requiredPaths) || raw.requiredPaths.some((value) => typeof value !== "string")
      || !Array.isArray(raw.requiredProfileCoverage) || raw.requiredProfileCoverage.some((value) => typeof value !== "string")) {
      throw new Error("Invalid Wiki publication finalization transaction");
    }
    return raw as unknown as PublicationFinalizationTransaction;
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function copySafeTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new WikiCandidateCorruptionError(`Candidate Wiki contains a symbolic link: ${from}`);
    if (entry.isDirectory()) await copySafeTree(from, to);
    else if (entry.isFile()) await writeDurableNew(to, await readFile(from, "utf8"));
    else throw new WikiCandidateCorruptionError(`Candidate Wiki contains a non-regular entry: ${from}`);
  }
  await syncDirectory(target);
}

async function restoreSafeTree(preimage: string, candidate: string, expectedDigest: string): Promise<void> {
  if (await digestWikiTree(preimage) !== expectedDigest) throw new WikiCandidateCorruptionError("Publication preimage digest mismatch");
  await rm(candidate, { recursive: true, force: true });
  await copySafeTree(preimage, candidate);
  if (await digestWikiTree(candidate) !== expectedDigest) throw new WikiCandidateCorruptionError("Restored publication preimage digest mismatch");
}

async function writeDurableNew(location: string, content: string): Promise<void> {
  const file = await open(location, "wx");
  try { await file.writeFile(content, "utf8"); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(path.dirname(location));
}

async function fileDigest(location: string): Promise<string | null> {
  try { await assertRegularOrMissing(location); return hash(await readFile(location)); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

async function assertRegularOrMissing(location: string): Promise<void> {
  try { if (!(await lstat(location)).isFile()) throw new WikiCandidateCorruptionError(`Candidate path must be a regular file: ${location}`); }
  catch (error) { if (!isMissing(error)) throw error; }
}

function sameBasis(basis: WikiReviewBasis, state: Pick<WikiLeadView, "candidateRevision" | "policyDigest">, treeDigest: string): boolean {
  return basis.candidateRevision === state.candidateRevision && basis.policyDigest === state.policyDigest && basis.treeDigest === treeDigest;
}
function assertReceiptForContract(receipt: WikiDelegateReceipt, contract: WikiDelegateContract, attempt: number, runId: string): void {
  const mismatches = [
    receipt.id !== contract.id && "task id",
    receipt.role !== contract.role && "role",
    receipt.attempts !== attempt && "attempt",
    receipt.contractId !== contract.contractId && "contract id",
    receipt.contractDigest !== contract.contractDigest && "contract digest",
    receipt.outputs.some((output) => output.runId !== runId || output.contractId !== contract.contractId || output.attempt !== attempt) && "artifact ownership",
  ].filter(Boolean);
  if (mismatches.length) throw new Error(`Delegate receipt does not match durable contract ${contract.contractId}: ${mismatches.join(", ")}`);
  if (contract.role === "review" && receipt.review && !sameStringSet(receipt.review.reviewedPaths, contract.reviewPaths)) {
    throw new Error(`Review receipt paths do not match durable contract ${contract.contractId}`);
  }
  if (contract.role === "research") {
    const assignments = new Set(contract.assignmentIds);
    const completed = receipt.completedAssignmentIds ?? [];
    if (completed.some((id) => !assignments.has(id))) {
      throw new Error(`Research receipt completedAssignmentIds do not match durable contract ${contract.contractId}`);
    }
    if (receipt.status === "complete" && (completed.length !== contract.assignmentIds.length
      || contract.assignmentIds.some((id) => !completed.includes(id)))) {
      throw new Error(`Research complete receipt completedAssignmentIds must exactly match durable contract ${contract.contractId}`);
    }
    const sourceScopes = new Set(contract.sourceScopeIds);
    for (const followup of receipt.followups ?? []) {
      if (followup.sourceScopeIds.some((id) => !sourceScopes.has(id))) {
        throw new Error(`Research receipt followup sourceScopeIds do not match durable contract ${contract.contractId}`);
      }
    }
  }
}
function replaceBatch(state: WikiLeadView, index: number, batch: WikiTaskRuntimeState["batches"][number]): WikiLeadView {
  const batches = [...state.delegates.batches];
  batches[index] = batch;
  return { ...state, delegates: { batches } };
}

function boardInput(facts: WikiLeadView, runId: string): WikiBoardProjectionInput {
  return {
    runId,
    specRevision: facts.specRevision,
    candidateRevision: facts.candidateRevision,
    sourceScopeIds: facts.sourceScopeIds,
    ...(facts.taxonomy ? { taxonomy: facts.taxonomy } : {}),
    compactionObserved: facts.compactionObserved,
    spec: facts.spec,
    reviews: facts.reviews.map((review) => ({ verdict: review.verdict, reviewedPaths: review.reviewedPaths })),
    delegates: {
      batches: facts.delegates.batches.map((batch) => ({
        batchId: batch.batchId,
        tasks: batch.tasks.map((task) => ({
          id: task.task.id,
          role: task.task.role,
          phase: task.phase,
          collected: task.collected,
          ...(task.task.role === "research" ? {
            mode: task.task.mode,
            sourceScopeIds: task.task.sourceScopeIds,
            contextRefs: task.task.contextRefs,
            assignmentIds: task.task.assignmentIds,
            domainScopeIds: task.task.domainScopeIds,
            lensScopeIds: task.task.lensScopeIds,
            resolvesIds: task.task.resolvesIds,
          } : {}),
          ...(task.task.role === "write" ? { writePaths: task.task.writePaths } : {}),
          ...(task.task.role === "review" ? { reviewPaths: task.task.reviewPaths } : {}),
          ...(task.receipt ? { receipt: {
            status: task.receipt.status,
            ...(task.receipt.error ? { error: { code: task.receipt.error.code } } : {}),
            ...(task.receipt.outputs ? { outputs: task.receipt.outputs } : {}),
            ...(task.receipt.completedAssignmentIds ? { completedAssignmentIds: task.receipt.completedAssignmentIds } : {}),
            ...(task.receipt.needsFollowup !== undefined ? { needsFollowup: task.receipt.needsFollowup } : {}),
            ...(task.receipt.followups ? { followups: task.receipt.followups } : {}),
            ...(task.receipt.coverage ? { coverage: task.receipt.coverage } : {}),
            ...(task.receipt.gaps ? { gaps: task.receipt.gaps } : {}),
            ...(task.receipt.domains ? { domains: task.receipt.domains } : {}),
            ...(task.receipt.review ? { review: { verdict: task.receipt.review.verdict } } : {}),
          } } : {}),
        })),
      })),
    },
  };
}
function expandDispatchTask(value: unknown, spec: WikiSpec | undefined, existingResearchTasks: readonly { id: string; mode: "discovery" | "supplement"; assignmentIds: readonly string[]; resolvesIds: readonly string[]; receipt?: { status: "complete" | "incomplete" | "failed"; error?: { code?: string }; gaps?: readonly unknown[]; followups?: readonly { id: string }[] } }[] = [], hostAssignmentId?: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const task = { ...(value as Record<string, unknown>) };
  const cluster = typeof task.cluster === "string" ? task.cluster : undefined;
  delete task.cluster;
  if (!Array.isArray(task.sourceScopeIds)) task.sourceScopeIds = [];
  if (!Array.isArray(task.contextRefs)) task.contextRefs = [];
  if (task.role === "research") {
    if (task.mode !== "discovery" && task.mode !== "supplement") task.mode = "discovery";
    const resolvesIds = Array.isArray(task.resolvesIds) ? task.resolvesIds.filter((value): value is string => typeof value === "string") : [];
    const blockerAssignments = new Map<string, readonly string[]>();
    for (const prior of existingResearchTasks) {
      const receipt = prior.receipt;
      const blockerIds = [
        ...(receipt?.error?.code && !(receipt.gaps?.length || receipt.followups?.length) ? [`failure:${prior.id}:${receipt.error.code}`] : []),
        ...(receipt?.gaps ?? []).map((_gap, index) => `gap:${prior.id}:${index + 1}`),
        ...(receipt?.followups ?? []).map((followup) => followup.id),
      ];
      for (const blockerId of blockerIds) blockerAssignments.set(blockerId, prior.assignmentIds);
    }
    task.assignmentIds = task.mode === "supplement"
      ? [...new Set(resolvesIds.flatMap((blockerId) => blockerAssignments.get(blockerId) ?? []))]
      : (hostAssignmentId ? [hostAssignmentId] : []);
    if (!Array.isArray(task.domainScopeIds)) task.domainScopeIds = [];
    if (!Array.isArray(task.lensScopeIds)) task.lensScopeIds = [];
    task.resolvesIds = resolvesIds;
    return task;
  }
  if (task.role !== "write" && task.role !== "review") return task;
  if (!cluster?.trim()) return task;
  if (!spec) throw new Error(`Submit an accepted WikiSpec before delegating ${task.role} tasks`);
  const paths = wikiSpecClusterPaths(spec, cluster).map((page) => `wiki/${page}`);
  if (!paths.length) return { ...task, cluster };
  if (task.role === "write") return { ...task, writePaths: paths };
  return { ...task, reviewPaths: paths };
}

function pendingWritePaths(state: WikiLeadView): string[] {
  return state.delegates.batches.flatMap((batch) => batch.tasks
    .filter((task) => task.task.role === "write" && task.phase !== "terminal")
    .flatMap((task) => task.task.writePaths ?? []));
}
function knownContextRefs(state: WikiLeadView): { contractId: string; sourceScopeIds: string[] }[] {
  return state.delegates.batches.flatMap((batch) => batch.tasks.flatMap((task) =>
    (task.receipt?.outputs ?? []).map((output) => ({ contractId: output.contractId, sourceScopeIds: [...task.task.sourceScopeIds] })),
  ));
}
function delegatedTaskCount(state: WikiLeadView): number {
  return state.delegates.batches.reduce((sum, batch) => sum + batch.tasks.length, 0);
}
function stripWikiPrefix(value: string): string { if (!value.startsWith("wiki/")) throw new Error(`Wiki path must start with wiki/: ${value}`); return value.slice(5); }
function candidateDirectory(workspace: string, candidate: string): string { return path.relative(workspace, candidate).split(path.sep).join("/"); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function isMissing(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT"); }


