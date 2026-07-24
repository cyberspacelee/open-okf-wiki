/**
 * Wiki Run orchestration on Pi + WikiRunShell (ADR 0030).
 * Single Layer-A driver for REST, CLI, and Operator Session adapters.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WikiRunPlan, WikiRunRecordStatus, WorkspaceConfig } from "@okf-wiki/contract";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { publishStagingToPublication, resolveSkillPath } from "@okf-wiki/core";
import { piRunWorkDir } from "./pi/session-paths.js";
import { resolveWikiSkillPaths } from "./pi/skill-paths.js";
import { attachProgress, type ProduceEventSink } from "./produce/events.js";
import { produceWithPi, shouldUsePiFixtureMode } from "./produce/live-pi.js";
import { produceWiki } from "./produce/orchestrate.js";
import { planWikiSpec } from "./produce/plan.js";
import {
  beginParentWikiProduceTool,
  type ParentToolEventEmit,
  type ParentToolSessionManager,
  type ParentWikiProduceToolHandle,
  WIKI_PRODUCE_TOOL_NAME,
} from "./produce/tools/parent-wiki-produce-tool.js";
import {
  createProduceProgressBridge,
  type ProduceProgressBridge,
  type ProduceProgressSessionManager,
  type ProduceToolDetails,
} from "./produce/tools/wiki-produce-progress.js";
import { redactErrorMessage } from "./run-redact.js";
import {
  markAwaitingPublish,
  markFailed,
  markHardValidate,
  markProducing,
  markPublished,
  resumeGate,
  startShell,
  type WikiRunShellState,
} from "./shell/wiki-run-shell.js";
import { writeWikiRunSpec } from "./spec-store.js";

export type WikiWorkflowJobEvent = {
  type: string;
  message?: string;
  data?: unknown;
};

export type WikiModelRoleName = "writer" | "planner" | "worker" | "reviewer";

export type WikiRunModelFactory = (role: WikiModelRoleName) => Promise<{
  model: Model<any>;
  modelRuntime?: ModelRuntime;
  maxContextTokens?: number;
  profileId?: string;
}>;

export type WikiWorkflowTerminal = {
  status: WikiRunRecordStatus;
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  error?: string;
  publicationPath?: string;
  suspended?: boolean;
  suspendGate?: "plan" | "publication";
  /** Final shell snapshot for adapters that cache in-memory. */
  shell?: WikiRunShellState;
};

export type WikiRunOrchestrationResult = WikiWorkflowTerminal;

export type StartWikiRunInput = {
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  skipPlanConfirm?: boolean;
  forcePlanConfirm?: boolean;
  plan?: WikiRunPlan;
  /**
   * When true (default), always run planner discovery before plan-gate /
   * produce so the Spec is source-grounded. Set false only when the caller
   * already supplies a final Spec (e.g. resume after revise).
   */
  discoverPlan?: boolean;
  /** Operator notes folded into Spec during discovery. */
  notes?: string;
  /** Optional model profile override (Settings). */
  modelProfileId?: string;
  /**
   * Injected model factory for live produce. Required when not in fixture mode.
   * Adapters (server job / registry / CLI) supply Settings-backed resolution.
   */
  resolveModel?: WikiRunModelFactory;
  /** Pre-resolved skill root from freezeWikiRun; otherwise resolved here. */
  skillRoot?: string;
  /** Pre-built source map from freeze; otherwise from workspace.sources. */
  sourcePathMap?: Map<string, string>;
  onEvent?: (event: WikiWorkflowJobEvent) => void;
  abortSignal?: AbortSignal;
  /**
   * Optional parent Operator Session manager for custom entries
   * (`okf.produce_progress`, not LLM context).
   */
  parentSessionManager?: ProduceProgressSessionManager;
  /**
   * Optional host-driven parent wiki_produce tool (Pi tool lifecycle).
   * When set, progress streams as tool_execution_* on the parent Session.
   * Prefer this over inventing product body injects.
   */
  parentWikiProduce?: ParentWikiProduceToolHandle;
  /**
   * When parentWikiProduce is omitted but parent tool I/O is provided,
   * startWikiRun begins the tool for the full start path.
   */
  parentToolIO?: {
    sessionManager: ParentToolSessionManager & ProduceProgressSessionManager;
    emit: ParentToolEventEmit;
  };
};

export type ResumeWikiRunInput = {
  runId: string;
  workspace: WorkspaceConfig;
  step: "plan-gate" | "publish-gate" | string;
  resumeData: {
    action: "approve" | "deny" | "revise";
    plan?: WikiRunPlan;
    feedback?: string;
  };
  /** Prior shell snapshot if server kept one; otherwise reconstructed. */
  shell?: WikiRunShellState;
  pages?: string[];
  plan?: WikiRunPlan;
  autoApprove?: boolean;
  resolveModel?: WikiRunModelFactory;
  skillRoot?: string;
  sourcePathMap?: Map<string, string>;
  onEvent?: (event: WikiWorkflowJobEvent) => void;
  abortSignal?: AbortSignal;
  /** See StartWikiRunInput.parentSessionManager. */
  parentSessionManager?: ProduceProgressSessionManager;
  parentWikiProduce?: ParentWikiProduceToolHandle;
  parentToolIO?: StartWikiRunInput["parentToolIO"];
};

function emit(
  onEvent: StartWikiRunInput["onEvent"],
  type: string,
  message?: string,
  data?: unknown,
): void {
  onEvent?.({ type, message, data });
}

function cancelledResult(shell?: WikiRunShellState): WikiWorkflowTerminal {
  return {
    status: "cancelled",
    error: "cancelled",
    summary: "Wiki Run cancelled",
    shell,
  };
}

function sourcesMap(
  workspace: WorkspaceConfig,
  override?: Map<string, string>,
): Map<string, string> {
  if (override && override.size > 0) return override;
  const m = new Map<string, string>();
  for (const s of workspace.sources ?? []) {
    if (s.id && s.path) m.set(s.id, s.path);
  }
  return m;
}

function resolveSkipPlanConfirm(input: StartWikiRunInput): boolean {
  if (input.forcePlanConfirm) return false;
  if (input.skipPlanConfirm === true) return true;
  if (input.autoApprove) return true;
  if (input.workspace.planConfirm === false) return true;
  return false;
}

/**
 * Build produce progress bridge.
 *
 * Live authority: parent wiki_produce tool onUpdate (tool_execution_update).
 * Optional job produce_progress kept for adapters that listen without a parent tool.
 * Cold: toolResult.details + okf.produce_progress custom entries.
 */
export function createWikiRunProduceBridge(opts: {
  onEvent?: StartWikiRunInput["onEvent"];
  parentSessionManager?: ProduceProgressSessionManager;
  parentWikiProduce?: ParentWikiProduceToolHandle;
  /** When true, also emit job produce_progress (legacy adapters). Default false when parent tool set. */
  emitJobProduceProgress?: boolean;
}): ProduceProgressBridge {
  const hasParentTool = Boolean(opts.parentWikiProduce);
  const emitJob =
    opts.emitJobProduceProgress === true || (!hasParentTool && opts.onEvent !== undefined);
  return createProduceProgressBridge({
    sessionManager: opts.parentSessionManager,
    onDetails: (details: ProduceToolDetails) => {
      if (emitJob) {
        emit(opts.onEvent, "produce_progress", details.status, details);
      }
    },
    onTree: (tree: ProduceToolDetails) => {
      try {
        opts.parentWikiProduce?.onUpdate(tree);
      } catch {
        // never break produce
      }
    },
  });
}

/** Complete parent wiki_produce tool from a terminal / post-produce result. */
export function completeParentWikiProduceTool(
  tool: ParentWikiProduceToolHandle | undefined,
  bridge: ProduceProgressBridge | undefined,
  result: { status: string; summary?: string; error?: string },
): void {
  if (!tool) return;
  const details = bridge?.getDetails() ?? {
    role: "root" as const,
    status:
      result.status === "failed" || result.status === "cancelled"
        ? ("failed" as const)
        : ("settled" as const),
    summary: result.summary ?? result.error,
    error: result.error,
  };
  const isError = result.status === "failed" || result.status === "cancelled";
  try {
    tool.complete({
      details: {
        ...details,
        status: isError ? "failed" : details.status === "running" ? "settled" : details.status,
        summary: result.summary ?? details.summary,
        error: result.error ?? details.error,
      },
      isError,
      summaryText: result.summary ?? result.error,
    });
  } catch {
    // best-effort
  }
}

/**
 * Map produce sink → job events.
 * Child trail: onProgress → bridge → parent tool onUpdate / optional produce_progress.
 * Never product work_unit inject (ADR 0031).
 */
function produceEventsFromJob(
  onEvent?: StartWikiRunInput["onEvent"],
  bridge?: ProduceProgressBridge,
): ProduceEventSink {
  const progressBridge =
    bridge ??
    createWikiRunProduceBridge({
      onEvent,
    });
  return {
    progress: (p) =>
      emit(onEvent, "phase", p.phase, {
        label: p.label,
        written: p.written,
        total: p.total,
        defectCount: p.defectCount,
      }),
    planProgress: (p) => emit(onEvent, "plan_progress", undefined, p),
    defects: (p) => emit(onEvent, "defects", p.summary, p),
    onProgress: progressBridge.onProgress,
  };
}

export type { ParentToolEventEmit, ParentToolSessionManager, ParentWikiProduceToolHandle };
export { beginParentWikiProduceTool, WIKI_PRODUCE_TOOL_NAME };

type RoleModel = {
  model: Model<any>;
  modelRuntime?: ModelRuntime;
  maxContextTokens?: number;
};

async function resolveRoleModels(
  resolveModel: WikiRunModelFactory | undefined,
  fixture: boolean,
): Promise<{
  writer?: RoleModel;
  planner?: RoleModel;
  worker?: RoleModel;
  reviewer?: RoleModel;
}> {
  if (fixture) return {};
  if (!resolveModel) {
    throw new Error("Live produce requires resolveModel factory (or OKF_WIKI_AGENT_MODE=fixture)");
  }
  const resolve = async (role: WikiModelRoleName): Promise<RoleModel> => {
    const resolved = await resolveModel(role);
    return {
      model: resolved.model,
      modelRuntime: resolved.modelRuntime,
      maxContextTokens: resolved.maxContextTokens,
    };
  };
  const writer = await resolve("writer");
  const planner = await resolve("planner").catch(() => writer);
  const worker = await resolve("worker").catch(() => writer);
  const reviewer = await resolve("reviewer").catch(() => writer);
  return { writer, planner, worker, reviewer };
}

/**
 * Materialize run workdir + run Planner before plan gate / produce.
 * Emits planning progress and planner onProgress (host-local; no work_unit).
 */
async function discoverWikiPlan(input: {
  runId: string;
  workspace: WorkspaceConfig;
  abortSignal?: AbortSignal;
  onEvent?: StartWikiRunInput["onEvent"];
  resolveModel?: WikiRunModelFactory;
  skillRoot?: string;
  sourcePathMap?: Map<string, string>;
  /** Operator notes to fold into Spec changelog. */
  notes?: string;
  parentSessionManager?: ProduceProgressSessionManager;
  /** Shared bridge across discovery + produce when available. */
  progressBridge?: ProduceProgressBridge;
}): Promise<WikiRunPlan> {
  const fixture = shouldUsePiFixtureMode({});
  const runWorkDir = piRunWorkDir(input.workspace.rootPath, input.runId);
  await mkdir(runWorkDir, { recursive: true });
  const skillRoot =
    input.skillRoot ??
    (await resolveSkillPath({
      workspaceRoot: input.workspace.rootPath,
      skillPath: input.workspace.skillPath,
    }));
  const sources = sourcesMap(input.workspace, input.sourcePathMap);
  if (sources.size === 0) {
    throw new Error("Wiki Run plan discovery requires at least one frozen source mount");
  }

  emit(input.onEvent, "phase", "planning", {
    label: "materialize + analyze sources",
  });

  const seeded = await produceWithPi({
    runWorkDir,
    role: "root_research",
    materialize: { sources, skillRoot, reset: true },
    fixture: true,
    title: input.workspace.name,
    abortSignal: input.abortSignal,
    workspaceRoot: input.workspace.rootPath,
  });

  const models = await resolveRoleModels(input.resolveModel, fixture);
  // Bridge: onProgress → ProduceToolDetails → produce_progress job event.
  // Settle/fail may append okf.produce_progress custom entry (not work_unit).
  const bridge =
    input.progressBridge ??
    createWikiRunProduceBridge({
      onEvent: input.onEvent,
      parentSessionManager: input.parentSessionManager,
    });
  const progressSink: ProduceEventSink = {
    onProgress: bridge.onProgress,
  };
  const planner = attachProgress(progressSink, {
    unitId: "planner",
    role: "planner",
    task: "Discover domains, pages, and acceptance criteria from sources/",
    parentId: "root",
  });
  planner.open();

  try {
    const planned = await planWikiSpec({
      runWorkDir,
      layout: seeded.layout,
      workspaceName: input.workspace.name,
      wikiLanguage: input.workspace.wikiLanguage,
      fixture,
      model: models.planner?.model,
      modelRuntime: models.planner?.modelRuntime,
      maxContextTokens: models.planner?.maxContextTokens,
      contextTargetTokens: input.workspace.limits?.contextTargetTokens,
      workspaceRoot: input.workspace.rootPath,
      abortSignal: input.abortSignal,
      useDefaultSpec: fixture,
      unitId: "planner",
      onPiEvent: planner.onPiEvent,
    });

    let spec = planned.spec;
    if (input.notes?.trim()) {
      spec = {
        ...spec,
        notes: [spec.notes, input.notes.trim()].filter(Boolean).join("\n\n"),
        changelog: [...(spec.changelog ?? []), "Operator notes on start"].slice(-40),
      };
    }
    await writeWikiRunSpec(input.workspace.rootPath, input.runId, spec);

    const summary =
      planned.rawSummary?.slice(0, 4000) ||
      [
        `Planned ${spec.pages?.length ?? 0} page(s), ${spec.domains?.length ?? 0} domain(s).`,
        `summary: ${spec.summary}`,
        `pages: ${(spec.pages ?? []).map((p) => p.path).join(", ")}`,
        `domains: ${(spec.domains ?? []).map((d) => d.id).join(", ")}`,
      ].join("\n");
    planner.settle(summary.slice(0, 4000));
    emit(input.onEvent, "phase", "planning", {
      label: `plan ready (${spec.pages?.length ?? 0} pages)`,
    });
    return spec;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    planner.fail(msg.slice(0, 4000));
    throw err;
  }
}

async function runProducePhase(input: {
  runId: string;
  workspace: WorkspaceConfig;
  plan?: WikiRunPlan;
  abortSignal?: AbortSignal;
  onEvent?: StartWikiRunInput["onEvent"];
  resolveModel?: WikiRunModelFactory;
  skillRoot?: string;
  sourcePathMap?: Map<string, string>;
  /** When true, keep existing run workdir (after pre-gate plan discovery). */
  preserveWorkdir?: boolean;
  parentSessionManager?: ProduceProgressSessionManager;
  progressBridge?: ProduceProgressBridge;
}): Promise<
  | { ok: true; pages: string[]; summary: string; wikiDir: string }
  | { ok: false; pages: string[]; summary: string; wikiDir: string; reasons: string[] }
> {
  const runWorkDir = piRunWorkDir(input.workspace.rootPath, input.runId);
  await mkdir(runWorkDir, { recursive: true });
  const skillRoot =
    input.skillRoot ??
    (await resolveSkillPath({
      workspaceRoot: input.workspace.rootPath,
      skillPath: input.workspace.skillPath,
    }));
  const sources = sourcesMap(input.workspace, input.sourcePathMap);
  if (sources.size === 0) {
    throw new Error("Wiki Run produce requires at least one frozen source mount (fail-closed)");
  }

  const fixture = shouldUsePiFixtureMode({});
  emit(input.onEvent, "phase", "producing", { runWorkDir, fixture });

  const models = await resolveRoleModels(input.resolveModel, fixture);

  const skillPaths = await resolveWikiSkillPaths({
    workspaceRoot: input.workspace.rootPath,
    skillPath: input.workspace.skillPath,
  }).catch(() => [] as string[]);

  const bridge =
    input.progressBridge ??
    createWikiRunProduceBridge({
      onEvent: input.onEvent,
      parentSessionManager: input.parentSessionManager,
    });

  const result = await produceWiki({
    runId: input.runId,
    workspace: input.workspace,
    runWorkDir,
    // Plan already approved / discovered — do not re-plan inside produce.
    spec: input.plan,
    skipPlan: true,
    materialize: {
      sources,
      skillRoot,
      // Preserve analysis/receipts when plan discovery already materialised.
      reset: input.preserveWorkdir ? false : true,
    },
    fixture,
    abortSignal: input.abortSignal,
    models: {
      writer: models.writer,
      planner: models.planner,
      worker: models.worker,
      reviewer: models.reviewer,
    },
    maxContextTokens: models.writer?.maxContextTokens,
    contextTargetTokens: input.workspace.limits?.contextTargetTokens,
    additionalSkillPaths: skillPaths,
    onEvent: produceEventsFromJob(input.onEvent, bridge),
  });

  if (result.status === "cancelled") {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }

  if (result.status === "failed") {
    return {
      ok: false,
      pages: result.pages,
      summary: result.summary,
      wikiDir: result.layout.wikiDir,
      reasons: result.publishability.reasons,
    };
  }

  return {
    ok: true,
    pages: result.pages,
    summary: result.summary,
    wikiDir: result.layout.wikiDir,
  };
}

async function maybePublish(input: {
  workspace: WorkspaceConfig;
  runId: string;
  wikiDir: string;
  autoApprove?: boolean;
}): Promise<{ publicationPath?: string }> {
  if (!input.autoApprove) {
    return {};
  }
  const publicationPath =
    input.workspace.publicationPath ?? path.join(input.workspace.rootPath, "wiki");
  const sources = (input.workspace.sources ?? []).map((s) => ({
    id: s.id,
    path: s.path,
  }));
  const pub = await publishStagingToPublication({
    stagingDir: input.wikiDir,
    publicationPath,
    runId: input.runId,
    sources,
  });
  return { publicationPath: pub.publicationPath };
}

async function afterProduce(input: {
  runId: string;
  workspace: WorkspaceConfig;
  plan?: WikiRunPlan;
  produced:
    | { ok: true; pages: string[]; summary: string; wikiDir: string }
    | {
        ok: false;
        pages: string[];
        summary: string;
        wikiDir: string;
        reasons: string[];
      };
  autoApprove?: boolean;
  shell: WikiRunShellState;
  onEvent?: StartWikiRunInput["onEvent"];
  abortSignal?: AbortSignal;
}): Promise<WikiWorkflowTerminal> {
  let shell = input.shell;
  if (input.abortSignal?.aborted) return cancelledResult(shell);

  shell = markHardValidate(shell, input.produced.pages, input.produced.summary);
  emit(input.onEvent, "phase", "hard_validate", {
    pages: input.produced.pages,
  });

  if (!input.produced.ok) {
    const message =
      input.produced.summary ||
      `hard-validate failed: ${input.produced.reasons.slice(0, 5).join("; ")}`;
    shell = markFailed(shell, message);
    emit(input.onEvent, "error", message, {
      reasons: input.produced.reasons,
    });
    return {
      status: "failed",
      error: message,
      summary: message,
      pages: input.produced.pages,
      plan: shell.plan,
      shell,
    };
  }

  const autoPub = input.autoApprove === true;
  if (!autoPub) {
    shell = markAwaitingPublish(shell, input.produced.pages, input.produced.summary);
    emit(input.onEvent, "gate", "awaiting_publication", {
      pages: input.produced.pages,
    });
    return {
      status: "awaiting_publication",
      pages: input.produced.pages,
      plan: shell.plan,
      summary: input.produced.summary,
      suspended: true,
      suspendGate: "publication",
      shell,
    };
  }

  const pub = await maybePublish({
    workspace: input.workspace,
    runId: input.runId,
    wikiDir: input.produced.wikiDir,
    autoApprove: true,
  });
  shell = markPublished(shell, input.produced.summary);
  emit(input.onEvent, "phase", "published", pub);
  return {
    status: "published",
    pages: input.produced.pages,
    plan: shell.plan,
    summary: input.produced.summary,
    publicationPath: pub.publicationPath,
    shell,
  };
}

/**
 * Start a Wiki Run:
 * 1) Discover Spec from sources (planner) unless caller disables it
 * 2) Optional plan-gate HITL
 * 3) produce → hard-validate → publish gate/auto
 */
export async function startWikiRun(input: StartWikiRunInput): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) return cancelledResult();

  const skipPlan = resolveSkipPlanConfirm(input);
  const shouldDiscover = input.discoverPlan !== false;
  let shell = startShell({
    plan: undefined,
    skipPlanConfirm: true,
  });
  let preserveWorkdir = false;

  // Host-driven parent wiki_produce tool (Pi tool_execution_* + JSONL messages).
  let parentTool = input.parentWikiProduce;
  let ownsParentTool = false;
  if (!parentTool && input.parentToolIO) {
    parentTool = beginParentWikiProduceTool({
      sessionManager: input.parentToolIO.sessionManager,
      emit: input.parentToolIO.emit,
      runId: input.runId,
    });
    ownsParentTool = true;
  }

  const sessionManager =
    input.parentSessionManager ??
    (input.parentToolIO?.sessionManager as ProduceProgressSessionManager | undefined);

  // One bridge for discovery + produce; streams tree to parent tool onUpdate.
  const progressBridge = createWikiRunProduceBridge({
    onEvent: input.onEvent,
    parentSessionManager: sessionManager,
    parentWikiProduce: parentTool,
  });

  const finishTool = (result: WikiWorkflowTerminal): WikiWorkflowTerminal => {
    // Keep tool open across plan-gate HITL so resume can continue the same row.
    if (result.suspended && result.suspendGate === "plan") {
      return result;
    }
    // Produce body done (incl. publication gate / published / failed / cancelled).
    if (ownsParentTool || input.parentWikiProduce) {
      completeParentWikiProduceTool(parentTool, progressBridge, {
        status: result.status,
        summary: result.summary,
        error: result.error,
      });
    }
    return result;
  };

  try {
    let plan: WikiRunPlan;
    if (shouldDiscover) {
      // Analyze first — never show a blank default Spec at the plan gate.
      plan = await discoverWikiPlan({
        runId: input.runId,
        workspace: input.workspace,
        abortSignal: input.abortSignal,
        onEvent: input.onEvent,
        resolveModel: input.resolveModel,
        skillRoot: input.skillRoot,
        sourcePathMap: input.sourcePathMap,
        notes: input.notes,
        parentSessionManager: sessionManager,
        progressBridge,
      });
      preserveWorkdir = true;
    } else {
      plan = input.plan ?? defaultWikiRunSpec(input.workspace.name);
    }

    if (!skipPlan) {
      shell = startShell({
        plan,
        skipPlanConfirm: false,
        summary: "Awaiting plan confirmation after source analysis",
      });
      emit(input.onEvent, "gate", "awaiting_plan", { plan: shell.plan });
      // Tool stays open (running) until resume or decline.
      return {
        status: "awaiting_plan",
        plan: shell.plan,
        summary: shell.summary ?? "Awaiting plan confirmation",
        suspended: true,
        suspendGate: "plan",
        shell,
      };
    }

    shell = startShell({ plan, skipPlanConfirm: true });
    shell = markProducing(shell);
    const produced = await runProducePhase({
      runId: input.runId,
      workspace: input.workspace,
      plan: shell.plan,
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
      resolveModel: input.resolveModel,
      skillRoot: input.skillRoot,
      sourcePathMap: input.sourcePathMap,
      preserveWorkdir,
      parentSessionManager: sessionManager,
      progressBridge,
    });
    return finishTool(
      await afterProduce({
        runId: input.runId,
        workspace: input.workspace,
        plan: shell.plan,
        produced,
        autoApprove: input.autoApprove,
        shell,
        onEvent: input.onEvent,
        abortSignal: input.abortSignal,
      }),
    );
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || /cancel/i.test(err.message))) {
      return finishTool(cancelledResult(shell));
    }
    const message = redactErrorMessage(err instanceof Error ? err.message : String(err));
    shell = markFailed(shell, message);
    emit(input.onEvent, "error", message);
    return finishTool({
      status: "failed",
      error: message,
      summary: message,
      shell,
    });
  }
}

/**
 * Resume plan or publication gate for an existing run.
 */
export async function resumeWikiRun(
  input: ResumeWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) return cancelledResult(input.shell);

  const gate = input.step === "publish-gate" || input.step === "publication" ? "publish" : "plan";

  let shell: WikiRunShellState =
    input.shell ??
    (gate === "plan"
      ? {
          phase: "awaiting_plan",
          plan: input.plan ?? input.resumeData.plan,
          pendingGate: "plan",
        }
      : {
          phase: "awaiting_publish",
          plan: input.plan,
          pages: input.pages,
          pendingGate: "publish",
        });

  try {
    shell = resumeGate(shell, {
      step: gate,
      action: input.resumeData.action,
      plan: input.resumeData.plan,
      feedback: input.resumeData.feedback,
    });

    let parentTool = input.parentWikiProduce;
    if (!parentTool && input.parentToolIO && gate === "plan") {
      // Fresh tool if prior handle was lost (process restart after plan gate).
      parentTool = beginParentWikiProduceTool({
        sessionManager: input.parentToolIO.sessionManager,
        emit: input.parentToolIO.emit,
        runId: input.runId,
        args: { resume: true },
      });
    }
    const sessionManager =
      input.parentSessionManager ??
      (input.parentToolIO?.sessionManager as ProduceProgressSessionManager | undefined);

    const finishTool = (result: WikiWorkflowTerminal): WikiWorkflowTerminal => {
      if (result.suspended && result.suspendGate === "plan") return result;
      completeParentWikiProduceTool(parentTool, progressBridgeRef.bridge, {
        status: result.status,
        summary: result.summary,
        error: result.error,
      });
      return result;
    };
    const progressBridgeRef: { bridge?: ProduceProgressBridge } = {};

    if (shell.phase === "cancelled") {
      return finishTool({
        status: "cancelled",
        plan: shell.plan,
        summary: shell.summary ?? "Plan declined",
        shell,
      });
    }
    if (shell.phase === "publication_declined") {
      return finishTool({
        status: "publication_declined",
        pages: shell.pages,
        plan: shell.plan,
        summary: shell.summary ?? "Publication declined",
        shell,
      });
    }
    if (shell.phase === "awaiting_plan") {
      return {
        status: "awaiting_plan",
        plan: shell.plan,
        suspended: true,
        suspendGate: "plan",
        summary: shell.summary,
        shell,
      };
    }

    // Plan approved → produce (workdir already materialised during discovery)
    if (gate === "plan" && shell.phase === "idle" && shell.plan) {
      shell = markProducing(shell);
      const progressBridge = createWikiRunProduceBridge({
        onEvent: input.onEvent,
        parentSessionManager: sessionManager,
        parentWikiProduce: parentTool,
      });
      progressBridgeRef.bridge = progressBridge;
      const produced = await runProducePhase({
        runId: input.runId,
        workspace: input.workspace,
        plan: shell.plan,
        abortSignal: input.abortSignal,
        onEvent: input.onEvent,
        resolveModel: input.resolveModel,
        skillRoot: input.skillRoot,
        sourcePathMap: input.sourcePathMap,
        preserveWorkdir: true,
        parentSessionManager: sessionManager,
        progressBridge,
      });
      return finishTool(
        await afterProduce({
          runId: input.runId,
          workspace: input.workspace,
          plan: shell.plan,
          produced,
          autoApprove: input.autoApprove,
          shell,
          onEvent: input.onEvent,
          abortSignal: input.abortSignal,
        }),
      );
    }

    // Publish approved — resumeGate already transitioned to published.
    if (gate === "publish" && shell.phase === "published") {
      const runWorkDir = piRunWorkDir(input.workspace.rootPath, input.runId);
      const wikiDir = path.join(runWorkDir, "wiki");
      const pub = await maybePublish({
        workspace: input.workspace,
        runId: input.runId,
        wikiDir,
        autoApprove: true,
      });
      return finishTool({
        status: "published",
        pages: shell.pages ?? input.pages,
        plan: shell.plan,
        summary: shell.summary,
        publicationPath: pub.publicationPath,
        shell,
      });
    }

    return finishTool({
      status: "failed",
      error: `unexpected shell phase after resume: ${shell.phase}`,
      summary: shell.summary,
      shell,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || /cancel/i.test(err.message))) {
      return cancelledResult(shell);
    }
    const message = redactErrorMessage(err instanceof Error ? err.message : String(err));
    shell = markFailed(shell, message);
    return { status: "failed", error: message, summary: message, shell };
  }
}

export function extractSuspendGate(
  result: WikiWorkflowTerminal,
): { gate: "plan" | "publication"; plan?: WikiRunPlan; pages?: string[] } | null {
  if (!result.suspended || !result.suspendGate) return null;
  return {
    gate: result.suspendGate === "plan" ? "plan" : "publication",
    plan: result.plan,
    pages: result.pages,
  };
}

export function sessionViewFromTerminal(result: WikiWorkflowTerminal): {
  status: string;
  phase: string;
  plan?: WikiRunPlan;
} {
  const phase =
    result.status === "awaiting_plan"
      ? "awaiting_plan"
      : result.status === "awaiting_publication"
        ? "awaiting_publish"
        : result.status === "published"
          ? "done"
          : result.status === "running"
            ? "writing"
            : "idle";
  return {
    status:
      result.status === "awaiting_plan" || result.status === "awaiting_publication"
        ? "waiting"
        : result.status === "published"
          ? "completed"
          : result.status === "failed" || result.status === "cancelled"
            ? "failed"
            : "running",
    phase,
    plan: result.plan,
  };
}

export { markCancelled, markFailed } from "./shell/wiki-run-shell.js";
