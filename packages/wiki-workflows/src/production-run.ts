import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createWikiArtifactStore } from "./artifact-store.js";
import { projectWikiAgentOutcome } from "./delegate-contracts.js";
import { removePath } from "./files.js";
import { inspectWiki, verifyPinnedSourcePlan } from "./inspect.js";
import { WikiLeadRun, type WikiLeadAgents } from "./lead.js";
import { createPiLeadAgents, type CreatePiLeadAgentsOptions } from "./pi/agents.js";
import type { PiWikiRoleModels } from "./pi/leaf.js";
import { createWikiPublicationStore } from "./publication-store.js";
import {
  createWikiRunRecord,
  projectRunView,
  type WikiExecutionAuthority,
  type WikiProductionTransition,
  type WikiRunFacts,
  type WikiRunRecord,
} from "./run-record.js";
import {
  WikiRunResultError,
  type WikiAgentInspection,
  type WikiAgentSnapshot,
  type WikiAgentTarget,
  type WikiInspectOptions,
  type WikiProducerRequest,
  type WikiProducer,
  type WikiProducerResult,
  type WikiRunControl,
  type WikiRunEvent,
  type WikiRunHandle,
  type WikiRunStage,
  type WikiRunUpdate,
  type WikiRunView,
} from "./producer-types.js";
import {
  WIKI_MANUAL_PAUSE,
  type WikiAgentRecord,
  type WikiLeadObservation,
  type WikiLeadOutcome,
  type WikiProductionPlan,
  type WikiTaskRuntimeTaskState,
} from "./runtime-types.js";
import { readWikiSessionTranscript } from "./session-transcript.js";
import { pin, reopen, skillWorkspacePath } from "./skill-store.js";
import { loadWikiWorkspace, ensureWikiWorkspaceInternalIgnore, DEFAULT_WORKSPACE_WIKI_CONFIG, type WikiGenerationProfile, type WikiRoleModelConfig } from "./workspace.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const UPDATE_IDLE_MS = 1_000;
const CONTROL_SETTLE_MS = 1_000;

export interface ProductionRuntimeOptions {
  getModel?: () => Model<Api> | undefined;
  getThinkingLevel?: () => ThinkingLevel | undefined;
  getModelRegistry?: () => ModelRegistry | undefined;
  /** Pi in production; tests may inject agents for WikiLeadRun.run. */
  createAgents?: (lead: WikiLeadRun, plan: WikiProductionPlan) => WikiLeadAgents;
  /** Scripted Lead loop: already-opened WikiLeadRun, no Pi. */
  runLead?: (lead: WikiLeadRun, context: {
    signal: AbortSignal;
    record: (observation: WikiLeadObservation) => void | Promise<void>;
    plan: WikiProductionPlan;
  }) => Promise<WikiLeadOutcome>;
  /** @internal Deterministic lifecycle dependencies. */
  now?: () => Date;
  createId?: () => string;
  cleanupPath?: (location: string) => Promise<void>;
  fault?: (point: "afterPublication") => void | Promise<void>;
}

interface ActiveAttempt {
  number: number;
  executionToken: string;
  readonly controller: AbortController;
  settled: Promise<void>;
}

/** Workspace/run registry. Lifecycle knowledge remains inside each WikiProductionRun. */
export class WikiProductionRuns implements WikiProducer {
  private readonly createId: () => string;
  private readonly records = new Map<string, WikiRunRecord>();
  private readonly runs = new Map<string, WikiProductionRun>();

  constructor(private readonly options: ProductionRuntimeOptions = {}) {
    this.createId = options.createId ?? randomUUID;
  }

  async start(request: WikiProducerRequest): Promise<WikiRunHandle> {
    const workspace = await loadWikiWorkspace(request.cwd);
    const record = this.record(workspace.root);
    const id = this.createId();
    const at = this.timestamp();
    await record.create({ id, cwd: workspace.root, ...(normalizedFocus(request.focus) ? { focus: normalizedFocus(request.focus) } : {}), at });
    const run = this.run(workspace.root, id, record);
    await run.start();
    return run.handle();
  }

  async open(runId: string, cwd: string): Promise<WikiRunHandle | undefined> {
    const workspace = await resolveWikiWorkspace(cwd);
    if (!workspace) return undefined;
    const record = this.record(workspace.root);
    if (!(await record.read(runId))) return undefined;
    const run = this.run(workspace.root, runId, record);
    await run.recover();
    return run.handle();
  }

  async list(cwd: string): Promise<WikiRunView[]> {
    const workspace = await resolveWikiWorkspace(cwd);
    if (!workspace) return [];
    return (await this.record(workspace.root).list()).map((facts) => projectRunView(facts));
  }

  private run(workspaceRoot: string, runId: string, record: WikiRunRecord): WikiProductionRun {
    const key = runKey(workspaceRoot, runId);
    let run = this.runs.get(key);
    if (!run) {
      run = new WikiProductionRun(path.resolve(workspaceRoot), runId, record, this.options);
      this.runs.set(key, run);
    }
    return run;
  }

  private record(workspaceRoot: string): WikiRunRecord {
    const root = path.join(path.resolve(workspaceRoot), ".okf-wiki");
    let record = this.records.get(root);
    if (!record) { record = createWikiRunRecord(root); this.records.set(root, record); }
    return record;
  }

  private timestamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

/** @internal Host model resolution and deterministic Lead construction. */
export function createConfiguredWikiProducer(options: ProductionRuntimeOptions = {}): WikiProducer {
  return new WikiProductionRuns(options);
}

/** Run-scoped deep module owning execution, recovery, controls, updates and cleanup. */
class WikiProductionRun {
  private active?: ActiveAttempt;
  private deferredResume?: WikiExecutionAuthority;
  private publicationCritical = false;
  private readonly hub = new EventEmitter();
  private readonly agents = new Map<string, WikiAgentRecord>();
  private liveFacts?: WikiRunFacts;
  private lastMessage?: string;
  private lastEvent?: WikiRunEvent;

  constructor(
    private readonly workspaceRoot: string,
    private readonly runId: string,
    private readonly record: WikiRunRecord,
    private readonly options: ProductionRuntimeOptions,
  ) { this.hub.setMaxListeners(0); }

  async start(): Promise<void> {
    await this.ensureLive();
    await this.commit({ kind: "started", at: this.timestamp() });
    const authority = await this.beginAttempt("attempt_started");
    this.launch(authority);
  }

  async recover(): Promise<void> {
    await this.ensureLive();
    const state = await this.state();
    if (state.status === "succeeded") {
      if (state.productionPlan) await this.cleanup(state.productionPlan, false);
      await createWikiPublicationStore({ workspace: state.cwd }).acknowledge(this.runId);
      return;
    }
    if (!TERMINAL.has(state.status) && state.productionPlan) {
      const publication = createWikiPublicationStore({ workspace: state.productionPlan.sourcePlan.workspaceRoot });
      const reconciliation = await publication.reconcile(this.runId);
      if (reconciliation.state === "published") {
        if (state.leadSummary === undefined) {
          throw new Error(`Committed Wiki publication ${this.runId} has incomplete run provenance`);
        }
        await this.cleanup(state.productionPlan);
        await this.commit({
          kind: "published", at: this.timestamp(), pages: [...reconciliation.pages],
          sourceFingerprint: reconciliation.sourceFingerprint,
          finalTreeDigest: reconciliation.finalTreeDigest,
        });
        await publication.acknowledge(this.runId);
        return;
      }
    }
    if (state.status === "running" && !this.active) {
      const ownership = await this.record.executionOwner(this.runId);
      if (ownership !== "live") await this.commit({ kind: "interrupted", at: this.timestamp() }, currentAuthority(state));
    }
  }

  handle(): WikiRunHandle {
    return {
      id: this.runId,
      view: async () => this.currentView() ?? this.viewFrom(await this.state()),
      updates: (signal?: AbortSignal) => this.updateStream(signal),
      result: async () => await this.waitForResult(),
      control: async (action) => await this.control(action),
      inspectAgent: async (target, options) => await this.inspectAgent(target, options),
    };
  }

  private launch(authority: WikiExecutionAuthority): void {
    if (this.active) return;
    const controller = new AbortController();
    const active: ActiveAttempt = { number: authority.attempt, executionToken: authority.executionToken, controller, settled: Promise.resolve() };
    this.active = active;
    const pending = this.execute(controller, authority);
    active.settled = pending;
    const settled = async () => {
      if (this.active !== active) return;
      this.active = undefined;
      if (this.deferredResume) {
        const deferred = this.deferredResume;
        this.deferredResume = undefined;
        const current = await this.record.read(this.runId).catch(() => undefined);
        if (current?.status === "running" && current.attempt === deferred.attempt && current.executionToken === deferred.executionToken) this.launch(deferred);
      }
    };
    void pending.then(settled, settled);
  }

  private async execute(controller: AbortController, authority: WikiExecutionAuthority): Promise<void> {
    const { attempt, executionToken } = authority;
    try {
      let state = await this.state();
      let plan = state.productionPlan;
      if (plan) await resumeProductionPlan(plan, this.runId);
      else {
        plan = await prepareProductionPlan(state.cwd, this.runId, state.focus, this.options);
        await this.assertCurrent(authority, controller.signal);
        await this.commitForAttempt(authority, controller.signal, { kind: "plan_pinned", at: this.timestamp(), plan });
      }
      await this.assertCurrent(authority, controller.signal);
      state = await this.state();
      plan = state.productionPlan!;
      const leadTail = await this.record.readTail(this.runId, { kind: "lead" });
      if (leadTail?.sessionFile) plan = { ...plan, leadSessionFile: leadTail.sessionFile, leadSessionAttempt: leadTail.agent.attempt };
      await this.commitForAttempt(authority, controller.signal, { kind: "stage_entered", at: this.timestamp(), stage: "lead", budgets: plan.budgets });
      const lead = await WikiLeadRun.open({
        workspace: plan.sourcePlan.workspaceRoot,
        runId: this.runId,
        candidateWikiRoot: plan.candidateWikiRoot,
        policy: plan.generation,
        requiredSections: plan.generation.templates.requiredSections,
        requiredProfileCoverage: plan.generation.review.mustCover,
        sourcePlan: plan.sourcePlan,
        language: plan.language,
        assertActive: () => this.record.assertActive(this.runId, authority),
        executionToken,
        commitLead: async (facts) => { await this.record.commitLead(this.runId, facts, authority); },
        readLead: async () => (await this.record.read(this.runId))?.lead,
        maxDelegatedTasks: plan.budgets.maxDelegatedTasks,
      });
      const record = async (observation: WikiLeadObservation) => {
        await this.applyLeadObservations(observation, authority, controller.signal);
      };
      const outcome = this.options.runLead
        ? await this.options.runLead(lead, { signal: controller.signal, record, plan })
        : await lead.run(
          this.options.createAgents?.(lead, plan) ?? createProductionAgents(lead, plan, this.options, await leadSessionLimits(plan.sourcePlan.workspaceRoot)),
          {
            signal: controller.signal,
            record,
            concurrency: Math.max(1, plan.maxConcurrentAgents - 1),
            maxDelegateBatches: plan.budgets.maxDelegateBatches,
            now: () => (this.options.now?.() ?? new Date()).getTime(),
            attempt: plan.leadSessionAttempt ?? attempt,
          },
        );
      await this.assertCurrent(authority, controller.signal);
      if (outcome.kind === "pause") {
        await this.commitForAttempt(authority, controller.signal, { kind: "paused", at: this.timestamp(), pause: {
          reason: outcome.reason, summary: outcome.summary, ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
        } });
        return;
      }
      await this.commitForAttempt(authority, controller.signal, { kind: "lead_completed", at: this.timestamp(), summary: outcome.summary });
      await this.commitForAttempt(authority, controller.signal, { kind: "stage_entered", at: this.timestamp(), stage: "validate" });
      await verifyPinnedSourcePlan(plan.sourcePlan);
      await this.assertCurrent(authority, controller.signal);
      const seal = await lead.sealForPublication({
        requiredProfileCoverage: plan.generation.review.mustCover,
        publicationAt: this.timestamp(),
        sourceFingerprint: plan.sourcePlan.fingerprint,
        summary: outcome.summary,
      });
      await this.assertCurrent(authority, controller.signal);
      await verifyPinnedSourcePlan(plan.sourcePlan);
      await this.commitForAttempt(authority, controller.signal, { kind: "stage_entered", at: this.timestamp(), stage: "publish" });
      const publication = createWikiPublicationStore({ workspace: plan.sourcePlan.workspaceRoot });
      this.publicationCritical = true;
      try {
        const published = await publication.publish(this.runId, seal);
        try { await this.options.fault?.("afterPublication"); }
        catch (cause) { throw new WikiProductionCrashFault(cause); }
        await this.cleanup(plan);
        await this.commit({
          kind: "published", at: this.timestamp(), pages: [...published.pages], sourceFingerprint: published.sourceFingerprint, finalTreeDigest: published.finalTreeDigest,
        }, authority);
        await publication.acknowledge(this.runId);
      } finally { this.publicationCritical = false; }
    } catch (error) {
      if (error instanceof WikiProductionCrashFault) return;
      if (controller.signal.aborted) return;
      const current = await this.record.read(this.runId);
      if (!current || current.status !== "running" || current.attempt !== attempt || current.executionToken !== executionToken) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.commit({ kind: "failed", at: this.timestamp(), error: message }, authority);
    }
  }

  private async cleanup(plan: WikiProductionPlan, recordWarning = true): Promise<void> {
    const runRoot = path.join(this.workspaceRoot, ".okf-wiki", "runs", this.runId);
    const targets = [
      plan.runSessionDirectory,
      plan.skillRoot,
      path.dirname(plan.candidateWikiRoot),
      path.join(runRoot, "publication-preimage"),
      path.join(runRoot, "publication-finalization.json"),
    ];
    const remove = this.options.cleanupPath ?? (async (location: string) => await removePath(location, { recursive: true, force: true }));
    const failures: string[] = [];
    for (const target of targets) {
      try { await remove(target); }
      catch (error) { failures.push(`${path.relative(runRoot, target)}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { await removeStagedEntries(runRoot, remove); }
    catch (error) { failures.push(`staged files: ${error instanceof Error ? error.message : String(error)}`); }
    if (failures.length && recordWarning) {
      const warning = { code: "cleanup_failed" as const, message: failures.join("; "), at: this.timestamp() };
      await this.commit({ kind: "warning", at: warning.at, warning });
    }
  }

  private async control(action: WikiRunControl): Promise<WikiRunView> {
    const state = await this.state();
    if (TERMINAL.has(state.status)) throw new Error(`Terminal Wiki run ${this.runId} cannot be controlled`);
    if (this.publicationCritical) throw new Error(`Wiki run ${this.runId} is committing publication and cannot be controlled`);
    if (action === "pause") {
      if (state.status !== "running") throw new Error(`Wiki run ${this.runId} is not running`);
      const authority = currentAuthority(state);
      const active = this.active;
      active?.controller.abort(WIKI_MANUAL_PAUSE);
      await settleBounded(active?.settled);
      await this.commit({ kind: "manual_paused", at: this.timestamp() }, authority);
    } else if (action === "resume") {
      if (state.status !== "paused") throw new Error(`Wiki run ${this.runId} is not paused`);
      const authority = await this.beginAttempt("resumed");
      if (this.active) this.deferredResume = authority;
      else this.launch(authority);
    } else {
      this.deferredResume = undefined;
      this.active?.controller.abort();
      await settleBounded(this.active?.settled);
      await this.commit({ kind: "cancelled", at: this.timestamp() }, state.status === "running" ? currentAuthority(state) : undefined);
    }
    return this.viewFrom(await this.state());
  }

  private async applyLeadObservations(
    observation: WikiLeadObservation,
    authority: WikiExecutionAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    await this.assertCurrent(authority, signal);
    if (observation.kind === "telemetry") {
      await this.record.noteLive(this.runId, {
        kind: "telemetry", target: observation.target, telemetry: observation.telemetry,
      }, authority);
      if (await this.refreshLiveIfFenced(authority)) await this.applyLiveTail(observation.target);
      return;
    }
    if (observation.kind === "health") {
      await this.record.noteLive(this.runId, {
        kind: "health", target: observation.target, status: observation.status, at: observation.at,
        ...(observation.message ? { message: observation.message } : {}),
      }, authority);
      if (await this.refreshLiveIfFenced(authority)) await this.applyLiveTail(observation.target);
      return;
    }
    if (observation.kind === "progress") {
      if (await this.refreshLiveIfFenced(authority)) {
        this.lastMessage = observation.message;
        this.emitLive(this.lastEvent ?? syntheticProgress(this.liveFacts!, this.lastMessage));
      }
      return;
    }
    if (observation.kind === "batch") {
      if (!(await this.refreshLiveIfFenced(authority))) return;
      const facts = await this.record.read(this.runId);
      if (facts) await this.replaceLive(facts);
      if (observation.phase === "queued" || observation.phase === "completed") {
        this.emitLive(delegateEvent(this.runId, observation, this.liveFacts ?? facts));
      } else {
        this.emitLive(this.lastEvent ?? syntheticProgress(this.liveFacts!, this.lastMessage));
      }
    }
  }

  private async applyLiveTail(target: WikiAgentTarget): Promise<void> {
    const tail = await this.record.readTail(this.runId, target);
    if (tail) this.agents.set(agentKey(target), tail);
    if (this.liveFacts) this.emitLive(this.lastEvent ?? syntheticProgress(this.liveFacts, this.lastMessage));
  }

  private async refreshLiveIfFenced(authority: WikiExecutionAuthority): Promise<boolean> {
    const current = await this.record.read(this.runId).catch(() => undefined);
    if (!current || current.status !== "running" || current.attempt !== authority.attempt
      || current.executionToken !== authority.executionToken) {
      if (current) await this.replaceLive(current);
      return false;
    }
    return true;
  }

  private async assertCurrent(authority: WikiExecutionAuthority, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.active || this.active.controller.signal !== signal || this.active.number !== authority.attempt
      || this.active.executionToken !== authority.executionToken) throw new Error("Wiki attempt is no longer current");
    const state = await this.state();
    if (state.status !== "running" || state.attempt !== authority.attempt || state.executionToken !== authority.executionToken) throw new Error("Wiki attempt is no longer current");
  }

  private async commitForAttempt(authority: WikiExecutionAuthority, signal: AbortSignal, transition: WikiProductionTransition): Promise<void> {
    await this.assertCurrent(authority, signal);
    await this.commit(transition, authority);
  }

  private async commit(transition: WikiProductionTransition, authority?: WikiExecutionAuthority): Promise<void> {
    const facts = await this.record.drive(this.runId, transition, authority);
    await this.publishCommitted(eventFromTransition(this.runId, transition, facts), facts);
  }

  private async beginAttempt(kind: "attempt_started" | "resumed"): Promise<WikiExecutionAuthority> {
    const executionToken = randomUUID();
    await this.commit({ kind, at: this.timestamp(), executionToken, owner: { pid: process.pid } });
    const state = await this.state();
    if (state.executionToken !== executionToken) throw new Error("Wiki execution token was not durably committed");
    return { attempt: state.attempt, executionToken };
  }

  private async publishCommitted(event: WikiRunEvent, facts?: WikiRunFacts): Promise<void> {
    await this.replaceLive(facts ?? await this.state());
    this.lastEvent = event;
    this.emitLive(event);
  }

  private async *updateStream(signal?: AbortSignal): AsyncIterable<WikiRunUpdate> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending: WikiRunUpdate[] = [];
    const enqueue = (update: WikiRunUpdate) => { pending.splice(0, pending.length, update); };
    this.hub.on("update", enqueue);
    try {
      await this.ensureLive();
      if (this.liveFacts && this.lastEvent) yield { event: this.lastEvent, view: this.viewFrom(this.liveFacts) };
      if (this.lastEvent && isTerminalEvent(this.lastEvent)) return;
      while (!combined.aborted) {
        const next = pending.shift();
        if (next) {
          yield next;
          if (isTerminalEvent(next.event)) return;
          continue;
        }
        await waitForUpdate(this.hub, combined, () => pending.length > 0);
      }
    } finally {
      this.hub.off("update", enqueue);
      controller.abort();
    }
  }

  private async waitForResult() {
    const controller = new AbortController();
    try {
      while (true) {
        const live = this.liveFacts;
        if (live && TERMINAL.has(live.status)) return await this.settleResult(live);
        const arrived = await waitForUpdate(this.hub, controller.signal, () => Boolean(this.liveFacts && TERMINAL.has(this.liveFacts.status)));
        if (this.liveFacts && TERMINAL.has(this.liveFacts.status)) continue;
        if (!arrived) {
          const disk = await this.state();
          if (TERMINAL.has(disk.status)) {
            this.liveFacts = structuredClone(disk);
            return await this.settleResult(disk);
          }
        }
      }
    } finally {
      controller.abort();
    }
  }

  private async settleResult(state: WikiRunFacts) {
    const execution = this.active?.settled;
    if (execution) await execution;
    const settled = this.liveFacts && TERMINAL.has(this.liveFacts.status) ? this.liveFacts : state;
    if (settled.status === "succeeded") return resultFromFacts(settled);
    if (settled.status === "failed" || settled.status === "cancelled") {
      throw new WikiRunResultError(this.runId, settled.status, settled.error ?? `Wiki run ${settled.status}`);
    }
    throw new Error(`Terminal Wiki run ${this.runId} regressed to ${settled.status}`);
  }

  private async inspectAgent(target: WikiAgentTarget, options?: WikiInspectOptions): Promise<WikiAgentInspection | undefined> {
    const facts = this.liveFacts ?? await this.state();
    const task = taskState(facts, target);
    const record = this.agents.get(agentKey(target)) ?? await this.record.readTail(this.runId, target).catch(() => undefined);
    const agent = record?.agent ?? agentFromView(this.viewFrom(facts), target);
    if (!agent) return undefined;
    const includeHandoff = options?.handoff === true;
    const includeTranscript = options?.transcript === true;
    const receipt = task?.receipt;
    const sessionFile = record?.sessionFile ?? task?.sessionFile;
    const ref = receipt?.outputs?.at(-1);
    let handoff: string | undefined;
    if (includeHandoff && ref) { try { handoff = await createWikiArtifactStore({ workspace: facts.cwd }).read(ref); } catch { handoff = undefined; } }
    return {
      runId: this.runId,
      agent,
      process: record?.process ?? [],
      ...(includeTranscript && sessionFile ? { messages: await readWikiSessionTranscript(sessionFile) } : {}),
      ...(receipt ? { outcome: projectWikiAgentOutcome(receipt) } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
      ...(includeHandoff && ref?.relativePath ? { handoffPath: ref.relativePath } : {}),
    };
  }

  private currentView(): WikiRunView | undefined {
    return this.liveFacts ? this.viewFrom(this.liveFacts) : undefined;
  }

  private viewFrom(facts: WikiRunFacts): WikiRunView {
    const view = projectRunView(facts, [...this.agents.values()]);
    if (!this.lastMessage || !view.progress) return view;
    return { ...view, progress: { ...view.progress, lastMessage: this.lastMessage } };
  }

  private emitLive(event: WikiRunEvent): void {
    if (!this.liveFacts) return;
    this.hub.emit("update", { event, view: this.viewFrom(this.liveFacts) } satisfies WikiRunUpdate);
  }

  private async ensureLive(): Promise<void> {
    if (this.liveFacts) return;
    await this.replaceLive(await this.state());
  }

  private async replaceLive(facts: WikiRunFacts): Promise<void> {
    this.liveFacts = structuredClone(facts);
    await this.loadTails(facts);
  }

  private async loadTails(facts: WikiRunFacts): Promise<void> {
    const next = new Map<string, WikiAgentRecord>();
    const lead = await this.record.readTail(this.runId, { kind: "lead" }).catch(() => undefined);
    if (lead) next.set(agentKey({ kind: "lead" }), lead);
    for (const batch of facts.lead.delegates.batches) {
      for (const task of batch.tasks) {
        const target = { kind: "task" as const, batch: batch.batchId, taskId: task.task.id };
        const tail = await this.record.readTail(this.runId, target).catch(() => undefined);
        if (tail) next.set(agentKey(target), tail);
      }
    }
    for (const [key, live] of this.agents) {
      const loaded = next.get(key);
      next.set(key, loaded ? { ...loaded, ...live, agent: { ...loaded.agent, ...live.agent } } : live);
    }
    this.agents.clear();
    for (const [key, record] of next) this.agents.set(key, record);
  }

  private async state(): Promise<WikiRunFacts> {
    const facts = await this.record.read(this.runId);
    if (!facts) throw new Error(`Unknown Wiki run: ${this.runId}`);
    return facts;
  }

  private timestamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

class WikiProductionCrashFault extends Error {
  constructor(cause: unknown) { super("Injected Wiki production process crash", { cause }); }
}

async function prepareProductionPlan(cwd: string, runId: string, focus: string | undefined, options: ProductionRuntimeOptions): Promise<WikiProductionPlan> {
  const workspace = await loadWikiWorkspace(cwd);
  const publication = createWikiPublicationStore({ workspace: workspace.root });
  await publication.recoverPending();
  await ensureWikiWorkspaceInternalIgnore(workspace.root);
  const sourcePlan = await inspectWiki(cwd);
  const candidateWikiRoot = await publication.prepareCandidate(runId);
  const { root: skillRoot, digest: skillTreeDigest } = await pin(workspace.root, runId);
  const runRoot = path.join(workspace.root, ".okf-wiki", "runs", runId);
  return {
    sourcePlan,
    candidateWikiRoot,
    skillRoot,
    skillTreeDigest,
    language: workspace.language,
    generation: structuredClone(workspace.wiki.generation),
    maxConcurrentAgents: workspace.wiki.maxConcurrentAgents,
    budgets: {
      maxDelegatedTasks: workspace.wiki.maxDelegatedTasks,
      maxDelegateBatches: workspace.wiki.maxDelegateBatches,
      maxTurnsPerSession: workspace.wiki.maxTurnsPerSession,
      maxToolCallsPerSession: workspace.wiki.maxToolCallsPerSession,
    },
    models: pinRoleModels(workspace.wiki.models, options),
    runSessionDirectory: path.join(runRoot, "sessions"),
    transientRetries: workspace.wiki.transientRetries,
    baseRetryDelayMs: workspace.wiki.baseRetryDelayMs,
    sessionTimeoutMs: workspace.wiki.sessionTimeoutSeconds * 1_000,
    prompt: leadPrompt(focus, sourcePlan.sources.map((source) => source.scopeId), runId, workspace.language, workspace.wiki.generation),
  };
}

async function resumeProductionPlan(plan: WikiProductionPlan, runId: string): Promise<void> {
  await verifyPinnedSourcePlan(plan.sourcePlan);
  const publication = createWikiPublicationStore({ workspace: plan.sourcePlan.workspaceRoot });
  await publication.recoverPending();
  const candidateWikiRoot = await publication.ensureCandidate(runId);
  await reopen(plan.sourcePlan.workspaceRoot, runId, plan.skillTreeDigest);
  if (path.resolve(candidateWikiRoot) !== path.resolve(plan.candidateWikiRoot)) throw new Error("Pinned Wiki candidate path changed during resume");
}

async function leadSessionLimits(workspaceRoot: string): Promise<{ maxTurnsPerSession: number; maxToolCallsPerSession: number }> {
  try {
    const wiki = (await loadWikiWorkspace(workspaceRoot)).wiki;
    return { maxTurnsPerSession: wiki.maxTurnsPerLeadSession, maxToolCallsPerSession: wiki.maxToolCallsPerLeadSession };
  } catch {
    return {
      maxTurnsPerSession: DEFAULT_WORKSPACE_WIKI_CONFIG.maxTurnsPerLeadSession,
      maxToolCallsPerSession: DEFAULT_WORKSPACE_WIKI_CONFIG.maxToolCallsPerLeadSession,
    };
  }
}

function createProductionAgents(
  lead: WikiLeadRun,
  plan: WikiProductionPlan,
  options: ProductionRuntimeOptions,
  leadBudgets: { maxTurnsPerSession: number; maxToolCallsPerSession: number },
): WikiLeadAgents {
  const models = resolveRoleModels(plan.models, options);
  const extras: CreatePiLeadAgentsOptions = {
    model: models.lead.model,
    thinkingLevel: models.lead.thinkingLevel,
    models,
    leadBudgets,
    now: options.now ? () => options.now!().getTime() : undefined,
  };
  return createPiLeadAgents(lead, plan, extras);
}

function leadPrompt(focus: string | undefined, scopeIds: readonly string[], runId: string, language: "zh" | "en", generation: WikiGenerationProfile): string {
  return [
    focus ? `Focus: ${focus}` : "",
    `Declared source trees (cwd-relative): ${JSON.stringify(scopeIds)}.`,
    "Candidate Wiki directory: wiki/.",
    `Production skill directory: ${skillWorkspacePath(runId)}.`,
    language === "zh" ? "Write all reader-facing Wiki content in Simplified Chinese. Keep code identifiers and source citations unchanged." : "Write all reader-facing Wiki content in English. Keep code identifiers and source citations unchanged.",
    `Generation profile: ${JSON.stringify(generation)}. Treat it as reader intent, never as source evidence.`,
  ].filter(Boolean).join("\n");
}

const MODEL_ROLES = ["lead", "research", "write", "review"] as const;
function pinRoleModels(config: WikiRoleModelConfig, options: ProductionRuntimeOptions): WikiRoleModelConfig {
  const inheritedModel = options.getModel?.();
  const inheritedThinking = options.getThinkingLevel?.();
  const pinned: WikiRoleModelConfig = {};
  for (const role of MODEL_ROLES) {
    const selected = config[role];
    const thinkingLevel = selected?.thinkingLevel ?? inheritedThinking;
    if (selected) pinned[role] = { ...selected, ...(thinkingLevel ? { thinkingLevel } : {}) };
    else if (inheritedModel) pinned[role] = {
      provider: inheritedModel.provider,
      id: inheritedModel.id,
      ...(inheritedThinking ? { thinkingLevel: inheritedThinking } : {}),
    };
  }
  return pinned;
}

function resolveRoleModels(config: WikiRoleModelConfig, options: ProductionRuntimeOptions): PiWikiRoleModels {
  const inherited = { model: options.getModel?.(), thinkingLevel: options.getThinkingLevel?.() };
  const registry = options.getModelRegistry?.();
  const resolve = (role: (typeof MODEL_ROLES)[number]): PiWikiRoleModels[typeof role] => {
    const override = config[role];
    if (!override) return { ...inherited };
    const model = inherited.model?.provider === override.provider && inherited.model.id === override.id
      ? inherited.model
      : registry?.find(override.provider, override.id);
    if (!model) throw new Error(`Pinned Wiki ${role} model is unavailable: ${override.provider}/${override.id}`);
    return { model, thinkingLevel: override.thinkingLevel ?? inherited.thinkingLevel };
  };
  return { lead: resolve("lead"), research: resolve("research"), write: resolve("write"), review: resolve("review") };
}

function resultFromFacts(facts: WikiRunFacts): WikiProducerResult {
  if (facts.status !== "succeeded") throw new Error(`Wiki run ${facts.id} has no successful result`);
  const publication = facts.publication;
  if (!publication || facts.leadSummary === undefined) {
    throw new Error(`Wiki run ${facts.id} has an invalid successful result`);
  }
  return {
    runId: facts.id,
    status: "succeeded",
    pages: publication.pages,
    sourceFingerprint: publication.sourceFingerprint,
    summary: facts.leadSummary,
  };
}

function eventFromTransition(runId: string, transition: WikiProductionTransition, facts: WikiRunFacts): WikiRunEvent {
  const base = { version: 1 as const, runId, at: transition.at };
  switch (transition.kind) {
    case "started":
      return { ...base, type: "started", message: "Started Wiki production" };
    case "attempt_started":
      return { ...base, type: "stage", stage: "prepare", message: "Preparing candidate Wiki" };
    case "plan_pinned":
      return { ...base, type: "stage", stage: facts.stage ?? "prepare", message: "Pinned Wiki production plan" };
    case "stage_entered":
      return { ...base, type: "stage", stage: transition.stage, message: stageMessage(transition.stage), ...(transition.budgets ? { budgets: transition.budgets } : {}) };
    case "lead_completed":
      return { ...base, type: "stage", stage: facts.stage ?? "lead", message: "Wiki Lead finished" };
    case "paused":
      return {
        ...base, type: "paused", message: transition.pause.summary, reason: transition.pause.reason,
        ...(transition.pause.retryAt ? { retryAt: transition.pause.retryAt } : {}),
      };
    case "interrupted":
      return { ...base, type: "paused", message: "Recovered interrupted Wiki run" };
    case "manual_paused":
      return { ...base, type: "paused", message: "Wiki run paused" };
    case "resumed":
      return { ...base, type: "resumed", message: "Wiki run resumed" };
    case "cancelled":
      return { ...base, type: "cancelled", message: "Wiki run cancelled" };
    case "failed":
      return { ...base, type: "failed", message: transition.error };
    case "warning":
      return { ...base, type: "warning", message: transition.warning.message, code: transition.warning.code, detail: transition.warning.message };
    case "published":
      return { ...base, type: "completed", message: "Wiki published" };
  }
}

function stageMessage(stage: WikiRunStage): string {
  switch (stage) {
    case "prepare": return "Preparing candidate Wiki";
    case "lead": return "Running Wiki Lead";
    case "validate": return "Validating candidate Wiki";
    case "publish": return "Publishing candidate Wiki";
  }
}

function delegateEvent(
  runId: string,
  observation: Extract<WikiLeadObservation, { kind: "batch" }>,
  facts: WikiRunFacts | undefined,
): WikiRunEvent {
  const tasks = facts
    ? (projectRunView(facts).progress?.batches?.find((batch) => batch.batch === observation.batch)?.tasks ?? [])
    : [];
  const completed = tasks.filter((task) => ["complete", "incomplete", "failed"].includes(task.status)).length;
  return {
    version: 1,
    runId,
    at: facts?.updatedAt ?? new Date().toISOString(),
    type: "delegate",
    message: `Wiki delegate batch ${observation.batch} ${observation.phase}`,
    phase: observation.phase === "queued" ? "queued" : "settled",
    batch: observation.batch,
    tasks: [...tasks],
    completed,
    total: tasks.length,
    ...(observation.taskId ? { taskId: observation.taskId } : {}),
  };
}

function taskState(facts: WikiRunFacts, target: WikiAgentTarget): WikiTaskRuntimeTaskState | undefined {
  if (target.kind !== "task") return undefined;
  return facts.lead.delegates.batches.find((batch) => batch.batchId === target.batch)
    ?.tasks.find((task) => task.task.id === target.taskId);
}

function agentFromView(view: WikiRunView, target: WikiAgentTarget): WikiAgentSnapshot | undefined {
  if (target.kind === "lead") return view.progress?.lead;
  const tasks = [
    ...(view.progress?.currentBatch?.tasks ?? []),
    ...(view.progress?.batches ?? []).flatMap((batch) => batch.tasks),
  ];
  return tasks.find((task) => task.target.kind === "task" && task.target.batch === target.batch && task.target.taskId === target.taskId);
}

async function removeStagedEntries(root: string, remove: (location: string) => Promise<void>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const location = path.join(root, entry.name);
    if (entry.name.endsWith(".candidate") || entry.name.includes(".tmp-")) {
      await remove(location);
    } else if (entry.isDirectory()) await removeStagedEntries(location, remove);
  }
}

function runKey(workspaceRoot: string, runId: string): string { return `${path.resolve(workspaceRoot)}\0${runId}`; }
function agentKey(target: WikiAgentTarget): string {
  return target.kind === "lead" ? "lead" : `task:${target.batch}:${target.taskId}`;
}
function syntheticProgress(facts: WikiRunFacts, lastMessage?: string): WikiRunEvent {
  return {
    version: 1, runId: facts.id, at: facts.updatedAt,
    type: "stage", stage: facts.stage ?? "lead", message: lastMessage ?? "",
  };
}
function currentAuthority(state: WikiRunFacts): WikiExecutionAuthority {
  if (state.status !== "running" || !state.executionToken) throw new Error("Wiki run has no active execution authority");
  return { attempt: state.attempt, executionToken: state.executionToken };
}

async function resolveWikiWorkspace(cwd: string) {
  try { return await loadWikiWorkspace(cwd); }
  catch { return undefined; }
}
function normalizedFocus(value: string | undefined): string | undefined { return value?.trim() || undefined; }
function isTerminalEvent(event: WikiRunEvent): boolean { return event.type === "completed" || event.type === "failed" || event.type === "cancelled"; }
async function waitForUpdate(hub: EventEmitter, signal: AbortSignal, delivered: () => boolean): Promise<boolean> {
  if (signal.aborted) return false;
  if (delivered()) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (arrived: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      hub.off("update", onUpdate);
      signal.removeEventListener("abort", onAbort);
      resolve(arrived);
    };
    const onUpdate = () => finish(true);
    const onAbort = () => finish(false);
    hub.on("update", onUpdate);
    if (delivered()) { finish(true); return; }
    if (signal.aborted) { finish(false); return; }
    timer = setTimeout(() => finish(false), UPDATE_IDLE_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function settleBounded(execution: Promise<void> | undefined): Promise<boolean> {
  if (!execution) return true;
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    execution.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CONTROL_SETTLE_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
