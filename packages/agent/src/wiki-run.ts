/**
 * Wiki Run orchestration on Pi + WikiRunShell (ADR 0030).
 * No Mastra / AI SDK.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { WikiRunPlan, WikiRunRecordStatus, WorkspaceConfig } from "@okf-wiki/contract";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  publishStagingToPublication,
  resolveSkillPath,
} from "@okf-wiki/core";
import { produceWithPi, shouldUsePiFixtureMode } from "./produce/live-pi.js";
import { piRunWorkDir } from "./pi/session-paths.js";
import { redactErrorMessage } from "./run-redact.js";
import {
  markAwaitingPublish,
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

export type WikiWorkflowTerminal = {
  status: WikiRunRecordStatus;
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  error?: string;
  publicationPath?: string;
  suspended?: boolean;
  suspendGate?: "plan" | "publication";
};

export type WikiRunOrchestrationResult = WikiWorkflowTerminal;

export type StartWikiRunInput = {
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  skipPlanConfirm?: boolean;
  forcePlanConfirm?: boolean;
  plan?: WikiRunPlan;
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

function cancelledResult(): WikiWorkflowTerminal {
  return {
    status: "cancelled",
    error: "cancelled",
    summary: "Wiki Run cancelled",
  };
}

function sourcesMap(workspace: WorkspaceConfig): Map<string, string> {
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

async function runProducePhase(input: {
  runId: string;
  workspace: WorkspaceConfig;
  plan?: WikiRunPlan;
  abortSignal?: AbortSignal;
  onEvent?: StartWikiRunInput["onEvent"];
}): Promise<{ pages: string[]; summary: string; wikiDir: string }> {
  const runWorkDir = piRunWorkDir(input.workspace.rootPath, input.runId);
  await mkdir(runWorkDir, { recursive: true });
  const skillRoot = await resolveSkillPath({
    workspaceRoot: input.workspace.rootPath,
    skillPath: input.workspace.skillPath,
  });
  emit(input.onEvent, "phase", "producing", { runWorkDir });
  const result = await produceWithPi({
    runWorkDir,
    role: "root_write",
    materialize: {
      sources: sourcesMap(input.workspace),
      skillRoot,
      reset: false,
    },
    fixture: shouldUsePiFixtureMode({}),
    title: input.plan?.summary ?? input.workspace.name ?? "Wiki",
    abortSignal: input.abortSignal,
  });
  return {
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
  // No workspace.publicationConfirm field — only autoApprove skips the publish gate.
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

/**
 * Start a Wiki Run: plan gate or produce → hard-validate → publish gate/auto.
 */
export async function startWikiRun(
  input: StartWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) return cancelledResult();

  const plan =
    input.plan ?? defaultWikiRunSpec(input.workspace.name);
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
      };
    }

    shell = markProducing(shell);
    const produced = await runProducePhase({
      runId: input.runId,
      workspace: input.workspace,
      plan: shell.plan,
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
    });
    if (input.abortSignal?.aborted) return cancelledResult();

    shell = markHardValidate(shell, produced.pages, produced.summary);
    emit(input.onEvent, "phase", "hard_validate", { pages: produced.pages });

    const autoPub = input.autoApprove === true;

    if (!autoPub) {
      shell = markAwaitingPublish(shell, produced.pages, produced.summary);
      emit(input.onEvent, "gate", "awaiting_publication", {
        pages: produced.pages,
      });
      return {
        status: "awaiting_publication",
        pages: produced.pages,
        plan: shell.plan,
        summary: produced.summary,
        suspended: true,
        suspendGate: "publication",
      };
    }

    const pub = await maybePublish({
      workspace: input.workspace,
      runId: input.runId,
      wikiDir: produced.wikiDir,
      autoApprove: true,
    });
    shell = markPublished(shell, produced.summary);
    emit(input.onEvent, "phase", "published", pub);
    return {
      status: "published",
      pages: produced.pages,
      plan: shell.plan,
      summary: produced.summary,
      publicationPath: pub.publicationPath,
    };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /cancel/i.test(err.message))
    ) {
      return cancelledResult();
    }
    const message = redactErrorMessage(
      err instanceof Error ? err.message : String(err),
    );
    emit(input.onEvent, "error", message);
    return {
      status: "failed",
      error: message,
      summary: message,
    };
  }
}

/**
 * Resume plan or publication gate for an existing run.
 */
export async function resumeWikiRun(
  input: ResumeWikiRunInput,
): Promise<WikiRunOrchestrationResult> {
  if (input.abortSignal?.aborted) return cancelledResult();

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
      };
    }
    if (shell.phase === "publication_declined") {
      return {
        status: "publication_declined",
        pages: shell.pages,
        plan: shell.plan,
        summary: shell.summary ?? "Publication declined",
      };
    }
    if (shell.phase === "awaiting_plan") {
      return {
        status: "awaiting_plan",
        plan: shell.plan,
        suspended: true,
        suspendGate: "plan",
        summary: shell.summary,
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
      });
      if (input.abortSignal?.aborted) return cancelledResult();
      shell = markHardValidate(shell, produced.pages, produced.summary);

      const autoPub = input.autoApprove === true;
      if (!autoPub) {
        shell = markAwaitingPublish(shell, produced.pages, produced.summary);
        return {
          status: "awaiting_publication",
          pages: produced.pages,
          plan: shell.plan,
          summary: produced.summary,
          suspended: true,
          suspendGate: "publication",
        };
      }
      const pub = await maybePublish({
        workspace: input.workspace,
        runId: input.runId,
        wikiDir: produced.wikiDir,
        autoApprove: true,
      });
      return {
        status: "published",
        pages: produced.pages,
        plan: shell.plan,
        summary: produced.summary,
        publicationPath: pub.publicationPath,
      };
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
      };
    }

    return {
      status: "failed",
      error: `unexpected shell phase after resume: ${shell.phase}`,
      summary: shell.summary,
    };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /cancel/i.test(err.message))
    ) {
      return cancelledResult();
    }
    const message = redactErrorMessage(
      err instanceof Error ? err.message : String(err),
    );
    return { status: "failed", error: message, summary: message };
  }
}

/** Audit replay: no Mastra snapshots — empty async generator. */
export async function* replayWikiRunAuditEvents(
  _runId: string,
): AsyncGenerator<WikiWorkflowJobEvent> {
  // Pi path does not persist Mastra workflow snapshots.
  yield { type: "audit", message: "no_mastra_snapshot" };
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
