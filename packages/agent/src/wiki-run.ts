/**
 * Wiki Run orchestration on Pi + WikiRunShell (ADR 0030).
 * Single Layer-A driver for REST, CLI, and Operator Session adapters.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  WikiRunPlan,
  WikiRunRecordStatus,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  publishStagingToPublication,
  resolveSkillPath,
} from "@okf-wiki/core";
import { produceWiki } from "./produce/orchestrate.js";
import { shouldUsePiFixtureMode } from "./produce/live-pi.js";
import type { ProduceEventSink } from "./produce/events.js";
import { resolveWikiSkillPaths } from "./pi/skill-paths.js";
import { piRunWorkDir } from "./pi/session-paths.js";
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

export type WikiWorkflowJobEvent = {
  type: string;
  message?: string;
  data?: unknown;
};

export type WikiModelRoleName =
  | "writer"
  | "planner"
  | "worker"
  | "reviewer";

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

function produceEventsFromJob(
  onEvent?: StartWikiRunInput["onEvent"],
): ProduceEventSink {
  return {
    progress: (p) =>
      emit(onEvent, "phase", p.phase, {
        label: p.label,
        written: p.written,
        total: p.total,
        defectCount: p.defectCount,
      }),
    planProgress: (p) => emit(onEvent, "plan_progress", undefined, p),
    agentSpan: (p) => emit(onEvent, "agent_span", p.status, p),
    defects: (p) => emit(onEvent, "defects", p.summary, p),
  };
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
    throw new Error(
      "Wiki Run produce requires at least one frozen source mount (fail-closed)",
    );
  }

  const fixture = shouldUsePiFixtureMode({});
  emit(input.onEvent, "phase", "producing", { runWorkDir, fixture });

  type RoleModel = {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
  let writerModel: RoleModel | undefined;
  let plannerModel: RoleModel | undefined;
  let workerModel: RoleModel | undefined;
  let reviewerModel: RoleModel | undefined;
  if (!fixture) {
    if (!input.resolveModel) {
      throw new Error(
        "Live produce requires resolveModel factory (or OKF_WIKI_AGENT_MODE=fixture)",
      );
    }
    const resolve = async (role: WikiModelRoleName): Promise<RoleModel> => {
      const resolved = await input.resolveModel!(role);
      return {
        model: resolved.model,
        modelRuntime: resolved.modelRuntime,
        maxContextTokens: resolved.maxContextTokens,
      };
    };
    writerModel = await resolve("writer");
    plannerModel = await resolve("planner").catch(() => writerModel!);
    workerModel = await resolve("worker").catch(() => writerModel!);
    reviewerModel = await resolve("reviewer").catch(() => writerModel!);
  }

  const skillPaths = await resolveWikiSkillPaths({
    workspaceRoot: input.workspace.rootPath,
    skillPath: input.workspace.skillPath,
  }).catch(() => [] as string[]);

  const result = await produceWiki({
    runId: input.runId,
    workspace: input.workspace,
    runWorkDir,
    // Plan already approved / defaulted at shell — do not re-plan unless missing.
    spec: input.plan,
    skipPlan: true,
    materialize: {
      sources,
      skillRoot,
      reset: true,
    },
    fixture,
    abortSignal: input.abortSignal,
    models: {
      writer: writerModel,
      planner: plannerModel,
      worker: workerModel,
      reviewer: reviewerModel,
    },
    maxContextTokens: writerModel?.maxContextTokens,
    contextTargetTokens: input.workspace.limits?.contextTargetTokens,
    additionalSkillPaths: skillPaths,
    onEvent: produceEventsFromJob(input.onEvent),
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
    input.workspace.publicationPath ??
    path.join(input.workspace.rootPath, "wiki");
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
    shell = markAwaitingPublish(
      shell,
      input.produced.pages,
      input.produced.summary,
    );
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
 * Start a Wiki Run: plan gate or produce → hard-validate → publish gate/auto.
 */
export async function startWikiRun(
  input: StartWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) return cancelledResult();

  const plan = input.plan ?? defaultWikiRunSpec(input.workspace.name);
  const skipPlan = resolveSkipPlanConfirm(input);
  let shell = startShell({
    plan,
    skipPlanConfirm: skipPlan,
  });

  try {
    if (shell.phase === "awaiting_plan") {
      emit(input.onEvent, "gate", "awaiting_plan", { plan: shell.plan });
      return {
        status: "awaiting_plan",
        plan: shell.plan,
        summary: shell.summary ?? "Awaiting plan confirmation",
        suspended: true,
        suspendGate: "plan",
        shell,
      };
    }

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
    });
    return afterProduce({
      runId: input.runId,
      workspace: input.workspace,
      plan: shell.plan,
      produced,
      autoApprove: input.autoApprove,
      shell,
      onEvent: input.onEvent,
      abortSignal: input.abortSignal,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /cancel/i.test(err.message))
    ) {
      return cancelledResult(shell);
    }
    const message = redactErrorMessage(
      err instanceof Error ? err.message : String(err),
    );
    shell = markFailed(shell, message);
    emit(input.onEvent, "error", message);
    return {
      status: "failed",
      error: message,
      summary: message,
      shell,
    };
  }
}

/**
 * Resume plan or publication gate for an existing run.
 */
export async function resumeWikiRun(
  input: ResumeWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) return cancelledResult(input.shell);

  const gate =
    input.step === "publish-gate" || input.step === "publication"
      ? "publish"
      : "plan";

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

    if (shell.phase === "cancelled") {
      return {
        status: "cancelled",
        plan: shell.plan,
        summary: shell.summary ?? "Plan declined",
        shell,
      };
    }
    if (shell.phase === "publication_declined") {
      return {
        status: "publication_declined",
        pages: shell.pages,
        plan: shell.plan,
        summary: shell.summary ?? "Publication declined",
        shell,
      };
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

    // Plan approved → produce
    if (gate === "plan" && shell.phase === "idle" && shell.plan) {
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
      });
      return afterProduce({
        runId: input.runId,
        workspace: input.workspace,
        plan: shell.plan,
        produced,
        autoApprove: input.autoApprove,
        shell,
        onEvent: input.onEvent,
        abortSignal: input.abortSignal,
      });
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
      return {
        status: "published",
        pages: shell.pages ?? input.pages,
        plan: shell.plan,
        summary: shell.summary,
        publicationPath: pub.publicationPath,
        shell,
      };
    }

    return {
      status: "failed",
      error: `unexpected shell phase after resume: ${shell.phase}`,
      summary: shell.summary,
      shell,
    };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /cancel/i.test(err.message))
    ) {
      return cancelledResult(shell);
    }
    const message = redactErrorMessage(
      err instanceof Error ? err.message : String(err),
    );
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
