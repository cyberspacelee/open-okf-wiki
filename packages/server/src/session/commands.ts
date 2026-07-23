/**
 * Agent session command handlers (prompt / steer / abort / compact / wiki run).
 *
 * Extracted from agent-session-registry for maintainability (no behavior change).
 */

import { randomUUID } from "node:crypto";
import {
  isTerminalPhase,
  markCancelled,
  markFailed,
  resumeWikiRun,
  startShell,
  startWikiRun,
  type WikiSessionHandle,
} from "@okf-wiki/agent";
import {
  type AgentCommand,
  type AgentCommandResponse,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  freezeWikiRun,
  FreezeWikiRunError,
} from "@okf-wiki/core";
import {
  emitPhase,
  emitRunLink,
} from "./product-inject.ts";
import {
  emitPi,
  mapOrchestratorOnEvent,
} from "./produce-adapter.ts";
import {
  ensureLiveHandle,
  makeResolveModel,
  persistTerminal,
  preferPiFixture,
  type RegisteredAgentSession,
} from "./parent-session.ts";

/**
 * Pi may complete session.prompt() without throwing while the last assistant
 * message has stopReason "error" (e.g. gateway 403). Surface that to HTTP + SSE.
 */
function lastAssistantProviderError(
  messages: readonly unknown[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (m.role !== "assistant") continue;
    if (
      m.stopReason === "error" ||
      m.stopReason === "aborted" ||
      (typeof m.errorMessage === "string" && m.errorMessage.trim())
    ) {
      return (
        (typeof m.errorMessage === "string" && m.errorMessage.trim()) ||
        `assistant stopReason=${m.stopReason ?? "error"}`
      );
    }
    return null;
  }
  return null;
}

export async function handlePrompt(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  text: string,
): Promise<AgentCommandResponse> {
  let handle: WikiSessionHandle;
  try {
    handle = await ensureLiveHandle(entry, workspace, "operator_chat");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "prompt",
      status: "failed",
      message: `prompt failed: ${message}`,
    };
  }
  emitPi(entry.workspaceId, entry.sessionId, "prompt", {
    textLength: text.length,
  });

  if (preferPiFixture()) {
    // Explicit OKF_WIKI_AGENT_MODE=fixture only — not the default.
    emitPi(entry.workspaceId, entry.sessionId, "message_end", {
      mode: "fixture",
      note: "OKF_WIKI_AGENT_MODE=fixture — no LLM; unset for live (requires API credentials)",
      textPreview: text.slice(0, 200),
    });
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "prompt",
      status: "accepted",
      message: "prompt accepted (explicit fixture mode — no LLM call)",
    };
  }

  entry.busy = true;
  try {
    await handle.session.prompt(text);
    const providerError = lastAssistantProviderError(handle.session.messages);
    if (providerError) {
      // SSE already carried message_end with errorMessage; also emit kind:error
      // so clients that only watch top-level errors still light up.
      emitPi(entry.workspaceId, entry.sessionId, "error", {
        message: providerError,
      });
      return {
        ok: false,
        sessionId: entry.sessionId,
        command: "prompt",
        status: "failed",
        message: `prompt failed: ${providerError}`,
      };
    }
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "prompt",
      status: "accepted",
      message: "prompt completed",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "prompt",
      status: "failed",
      message: `prompt failed: ${message}`,
    };
  } finally {
    entry.busy = false;
  }
}

export async function handleSteer(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  text: string,
): Promise<AgentCommandResponse> {
  let handle: WikiSessionHandle;
  try {
    handle = await ensureLiveHandle(entry, workspace, "operator_chat");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "steer",
      status: "failed",
      message: `steer failed: ${message}`,
    };
  }
  emitPi(entry.workspaceId, entry.sessionId, "steer", {
    textLength: text.length,
  });

  if (preferPiFixture()) {
    emitPi(entry.workspaceId, entry.sessionId, "queue_update", {
      mode: "fixture",
      steering: [text.slice(0, 200)],
    });
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "steer",
      status: "accepted",
      message: "steer accepted (fixture mode)",
    };
  }

  try {
    await handle.session.steer(text);
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "steer",
      status: "accepted",
      message: "steer queued",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "steer",
      status: "failed",
      message: `steer failed: ${message}`,
    };
  }
}

export async function handleAbort(
  entry: RegisteredAgentSession,
): Promise<AgentCommandResponse> {
  entry.abortController?.abort();
  if (entry.handle) {
    try {
      await entry.handle.session.abort();
    } catch {
      // ignore abort races
    }
  }
  if (entry.shell && !isTerminalPhase(entry.shell.phase)) {
    entry.shell = markCancelled(entry.shell, "Aborted by operator");
    emitPhase(entry, "cancelled", "Aborted by operator", "cancelled");
  }
  emitPi(entry.workspaceId, entry.sessionId, "abort", {});
  return {
    ok: true,
    sessionId: entry.sessionId,
    command: "abort",
    status: "accepted",
    message: "abort requested",
    runId: entry.runId,
  };
}

export async function handleCompact(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
): Promise<AgentCommandResponse> {
  if (entry.handle && !preferPiFixture()) {
    try {
      await entry.handle.session.compact();
      emitPi(entry.workspaceId, entry.sessionId, "compaction_end", {
        mode: "live",
      });
      return {
        ok: true,
        sessionId: entry.sessionId,
        command: "compact",
        status: "accepted",
        message: "compact completed",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitPi(entry.workspaceId, entry.sessionId, "error", { message });
      return {
        ok: true,
        sessionId: entry.sessionId,
        command: "compact",
        status: "accepted",
        message: `compact failed: ${message}`,
      };
    }
  }

  // Ensure handle exists so tools/role are ready; compact itself needs a model.
  try {
    await ensureLiveHandle(entry, workspace, "operator_chat");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "compact",
      status: "accepted",
      message: `compact failed: ${message}`,
    };
  }
  emitPi(entry.workspaceId, entry.sessionId, "compaction_end", {
    mode: "fixture",
    note: "compact skipped in fixture mode",
  });
  return {
    ok: true,
    sessionId: entry.sessionId,
    command: "compact",
    status: "accepted",
    message: "compact accepted (fixture mode — no LLM summary)",
  };
}

export async function handleStartWikiRun(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  command: Extract<AgentCommand, { type: "start_wiki_run" }>,
): Promise<AgentCommandResponse> {
  if (entry.busy) {
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "start_wiki_run",
      status: "failed",
      message: "session busy; start_wiki_run ignored",
      runId: entry.runId,
    };
  }

  entry.produceModelProfileId = command.modelProfileId?.trim() || undefined;

  let frozen;
  try {
    frozen = await freezeWikiRun({
      workspace,
      sessionId: entry.sessionId,
      autoApprove: command.autoApprove === true,
      runId: randomUUID(),
    });
  } catch (err) {
    const message =
      err instanceof FreezeWikiRunError
        ? err.message
        : err instanceof Error
          ? err.message
          : "freeze failed";
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    emitPhase(entry, "failed", message, "failed");
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "start_wiki_run",
      status: "failed",
      message: `freeze failed: ${message}`,
    };
  }

  entry.runId = frozen.runId;
  // Shell snapshot before startWikiRun returns — cold-load can still see a run.
  entry.shell = startShell({ skipPlanConfirm: true });
  emitRunLink(entry, "running");
  emitPhase(
    entry,
    "planning",
    command.notes ?? "start_wiki_run",
    "running",
  );
  if (entry.produceModelProfileId) {
    emitPi(entry.workspaceId, entry.sessionId, "wiki_run_model", {
      modelProfileId: entry.produceModelProfileId,
      role: "writer",
    });
  }

  const skipPlanConfirm =
    command.autoApprove === true || workspace.planConfirm === false;
  const controller = new AbortController();
  entry.abortController = controller;

  const runOpts = {
    runId: frozen.runId,
    workspace,
    // Discover Spec from sources first (do not pass a blank default plan).
    discoverPlan: true,
    notes: command.notes,
    autoApprove: command.autoApprove === true,
    skipPlanConfirm,
    resolveModel: preferPiFixture()
      ? undefined
      : makeResolveModel(workspace, entry),
    skillRoot: frozen.skillPath,
    sourcePathMap: frozen.sourcePathMap,
    abortSignal: controller.signal,
    onEvent: mapOrchestratorOnEvent(entry),
  };

  // Always background so planner SSE streams before plan-gate / produce.
  // (Previously planConfirm awaited and returned instantly with a default Spec.)
  entry.busy = true;
  void startWikiRun(runOpts)
    .then(async (result) => {
      if (result.shell) entry.shell = result.shell;
      await persistTerminal(entry, workspace, result);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      emitPi(entry.workspaceId, entry.sessionId, "error", { message });
      if (entry.shell && !isTerminalPhase(entry.shell.phase)) {
        entry.shell = markFailed(entry.shell, message);
        emitPhase(entry, "failed", message, "failed");
      }
    })
    .finally(() => {
      entry.busy = false;
      entry.abortController = undefined;
      entry.produceModelProfileId = undefined;
    });

  return {
    ok: true,
    sessionId: entry.sessionId,
    command: "start_wiki_run",
    status: "accepted",
    message: skipPlanConfirm
      ? preferPiFixture()
        ? "Wiki run produce started (fixture mode)"
        : "Wiki run: analyzing sources then producing"
      : "Wiki run: analyzing sources before plan approval",
    runId: frozen.runId,
  };
}

export async function handleResumeGate(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  command: Extract<AgentCommand, { type: "resume_gate" }>,
): Promise<AgentCommandResponse> {
  if (!entry.shell && !entry.runId && !command.runId) {
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "resume_gate",
      status: "failed",
      message: "no active shell — resume ignored",
      runId: command.runId ?? entry.runId,
    };
  }

  if (command.runId) {
    entry.runId = command.runId;
  }
  if (!entry.runId) {
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "resume_gate",
      status: "failed",
      message: "no runId — resume ignored",
    };
  }

  const step =
    command.gate === "publication" ? "publish-gate" : "plan-gate";
  const controller = new AbortController();
  entry.abortController = controller;
  entry.busy = true;
  if (command.gate === "plan" && command.action === "approve") {
    // Surface writing/busy for cold-load + UI before resumeWikiRun returns.
    // Keep shell at awaiting_plan until resumeGate transitions it — mutating
    // shell here would break resumeGate's phase assertions.
    // Phase is durable via trajectory run_phase (no dual in-memory phase).
    emitPhase(entry, "writing", "plan approved — producing", "running");
  }

  try {
    const result = await resumeWikiRun({
      runId: entry.runId,
      workspace,
      step,
      resumeData: {
        action: command.action,
        plan: command.plan,
        feedback: command.feedback,
      },
      shell: entry.shell,
      pages: entry.shell?.pages,
      plan: command.plan ?? entry.shell?.plan,
      autoApprove: command.gate === "publication" && command.action === "approve"
        ? true
        : undefined,
      resolveModel: preferPiFixture()
        ? undefined
        : makeResolveModel(workspace, entry),
      abortSignal: controller.signal,
      onEvent: mapOrchestratorOnEvent(entry),
    });

    await persistTerminal(entry, workspace, result);

    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "resume_gate",
      status: "accepted",
      message: `gate ${command.gate} ${command.action} → ${result.status}`,
      runId: entry.runId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    if (entry.shell && !isTerminalPhase(entry.shell.phase)) {
      entry.shell = markFailed(entry.shell, message);
      emitPhase(entry, "failed", message, "failed");
      emitRunLink(entry, "failed");
    }
    return {
      ok: false,
      sessionId: entry.sessionId,
      command: "resume_gate",
      status: "failed",
      message: `resume_gate failed: ${message}`,
      runId: entry.runId,
    };
  } finally {
    entry.busy = false;
    entry.abortController = undefined;
    entry.produceModelProfileId = undefined;
  }
}
