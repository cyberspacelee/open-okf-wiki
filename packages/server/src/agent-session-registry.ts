/**
 * In-process registry for Pi agent sessions (ADR 0030).
 *
 * Maps sessionId → live WikiSessionHandle (when created), WikiRunShell state,
 * and workspace root. Routes stay thin; this module owns command side-effects.
 */

import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createWikiSession,
  isTerminalPhase,
  markAwaitingPublish,
  markCancelled,
  markFailed,
  markHardValidate,
  markProducing,
  piRunWorkDir,
  piSessionPath,
  piSessionsDir,
  produceWithPi,
  resumeGate,
  shouldUsePiFixtureMode,
  startShell,
  type WikiRunShellState,
  type WikiSessionHandle,
} from "@okf-wiki/agent";
import {
  defaultWikiRunSpec,
  type AgentCommand,
  type AgentCommandResponse,
  type ProductSseEvent,
  type WikiRunPlan,
  type WikiRunRecordStatus,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { isPathInside, resolveSkillPath } from "@okf-wiki/core";
import {
  emitAgentSessionEvent,
  emitProductAgentEvent,
} from "./agent-session-events.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegisteredAgentSession = {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceName: string;
  title: string;
  createdAt: string;
  /** Absolute path to product meta JSON under pi-sessions. */
  metaPath: string;
  /** Workdir used as cwd for the operator chat session. */
  sessionWorkDir: string;
  /** Live Pi handle for operator chat (lazily created on first prompt/steer). */
  handle?: WikiSessionHandle;
  /** Unsubscribe from Pi session events. */
  unsubPi?: () => void;
  /** Active WikiRunShell state when a run has been started. */
  shell?: WikiRunShellState;
  runId?: string;
  /** Abort controller for in-flight produce. */
  abortController?: AbortController;
  /** True while prompt/produce is running. */
  busy: boolean;
};

const sessions = new Map<string, RegisteredAgentSession>();

function regKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Fixture only when explicitly requested (`OKF_WIKI_AGENT_MODE=fixture`).
 * Default is live; missing credentials fail on the live path with a clear error.
 */
export function preferPiFixture(): boolean {
  return shouldUsePiFixtureMode({});
}

// ---------------------------------------------------------------------------
// Product phase mapping (shell → SSE product injects)
// ---------------------------------------------------------------------------

type ProductPhase = Extract<ProductSseEvent, { kind: "run_phase" }>["phase"];

function productPhaseFromShell(phase: WikiRunShellState["phase"]): ProductPhase {
  switch (phase) {
    case "idle":
      return "idle";
    case "awaiting_plan":
      return "awaiting_plan";
    case "producing":
    case "hard_validate":
      return "writing";
    case "awaiting_publish":
      return "awaiting_publish";
    case "published":
    case "publication_declined":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

function statusFromShell(phase: WikiRunShellState["phase"]): WikiRunRecordStatus {
  switch (phase) {
    case "awaiting_plan":
      return "awaiting_plan";
    case "producing":
    case "hard_validate":
    case "idle":
      return "running";
    case "awaiting_publish":
      return "awaiting_publication";
    case "published":
      return "published";
    case "publication_declined":
      return "publication_declined";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

function safeJsonPayload(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint") return String(v);
        if (typeof v === "function" || typeof v === "symbol") return undefined;
        return v;
      }),
    );
  } catch {
    return { note: "non-serializable pi event" };
  }
}

function emitPi(
  workspaceId: string,
  sessionId: string,
  kind: string,
  payload?: unknown,
): void {
  emitAgentSessionEvent(workspaceId, sessionId, {
    source: "pi",
    kind,
    sessionId,
    payload: payload === undefined ? undefined : safeJsonPayload(payload),
    timestamp: nowIso(),
  });
}

function emitPhase(
  entry: RegisteredAgentSession,
  phase: ProductPhase,
  message?: string,
  status?: WikiRunRecordStatus,
): void {
  emitProductAgentEvent(entry.workspaceId, {
    source: "product",
    kind: "run_phase",
    sessionId: entry.sessionId,
    runId: entry.runId,
    phase,
    status,
    message,
    timestamp: nowIso(),
  });
}

function emitGate(
  entry: RegisteredAgentSession,
  gate: "plan" | "publication",
  question: string,
  plan?: WikiRunPlan,
  pages?: string[],
): void {
  emitProductAgentEvent(entry.workspaceId, {
    source: "product",
    kind: "gate",
    sessionId: entry.sessionId,
    runId: entry.runId,
    gate,
    question,
    plan,
    pages,
    timestamp: nowIso(),
  });
}

function emitRunLink(entry: RegisteredAgentSession, status?: WikiRunRecordStatus): void {
  if (!entry.runId) return;
  emitProductAgentEvent(entry.workspaceId, {
    source: "product",
    kind: "run_link",
    sessionId: entry.sessionId,
    runId: entry.runId,
    status,
    timestamp: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function sessionMetaPath(workspaceRoot: string, sessionId: string): string {
  return path.join(piSessionsDir(workspaceRoot), `${sessionId}.json`);
}

export async function ensurePiSessionsDir(workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const dir = piSessionsDir(root);
  if (!isPathInside(root, dir)) {
    throw new Error("pi-sessions dir escapes workspace root");
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function agentSessionExistsOnDisk(
  workspaceRoot: string,
  sessionId: string,
): Promise<boolean> {
  const dir = piSessionsDir(workspaceRoot);
  const candidates = [
    sessionMetaPath(workspaceRoot, sessionId),
    path.join(dir, `${sessionId}.jsonl`),
    path.join(dir, sessionId),
    piSessionPath(workspaceRoot, sessionId),
  ];
  for (const p of candidates) {
    try {
      await stat(p);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Registry CRUD
// ---------------------------------------------------------------------------

export function getRegisteredAgentSession(
  workspaceId: string,
  sessionId: string,
): RegisteredAgentSession | undefined {
  return sessions.get(regKey(workspaceId, sessionId));
}

/** Test helper. */
export function resetAgentSessionRegistryForTests(): void {
  for (const entry of sessions.values()) {
    disposeEntry(entry);
  }
  sessions.clear();
}

function disposeEntry(entry: RegisteredAgentSession): void {
  try {
    entry.unsubPi?.();
  } catch {
    // ignore
  }
  entry.unsubPi = undefined;
  try {
    entry.handle?.dispose();
  } catch {
    // ignore
  }
  entry.handle = undefined;
  entry.abortController?.abort();
  entry.abortController = undefined;
}

/**
 * Create product-side session meta + registry entry.
 * Does not construct a live AgentSession until first prompt (cheap create).
 */
export async function registerAgentSession(input: {
  workspace: WorkspaceConfig;
  sessionId?: string;
  title?: string;
}): Promise<RegisteredAgentSession> {
  const sessionId = input.sessionId?.trim() || randomUUID();
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) {
    throw new Error("sessionId must be alphanumeric (._- allowed)");
  }

  const workspaceRoot = path.resolve(input.workspace.rootPath);
  await ensurePiSessionsDir(workspaceRoot);

  const metaPath = sessionMetaPath(workspaceRoot, sessionId);
  if (!isPathInside(workspaceRoot, metaPath)) {
    throw new Error("session path escapes workspace");
  }

  const sessionWorkDir = piSessionPath(workspaceRoot, sessionId);
  await mkdir(sessionWorkDir, { recursive: true });

  const createdAt = nowIso();
  const title =
    input.title?.trim() || `Wiki Agent · ${input.workspace.name}`;

  const meta = {
    schema: "okf.pi-session/v1",
    id: sessionId,
    workspaceId: input.workspace.id,
    title,
    createdAt,
    updatedAt: createdAt,
    sessionWorkDir,
    /** Live handle is created lazily on prompt. */
    stub: false,
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  const entry: RegisteredAgentSession = {
    sessionId,
    workspaceId: input.workspace.id,
    workspaceRoot,
    workspaceName: input.workspace.name,
    title,
    createdAt,
    metaPath,
    sessionWorkDir,
    busy: false,
  };

  // Replace any prior in-memory entry for this id.
  const key = regKey(entry.workspaceId, sessionId);
  const prior = sessions.get(key);
  if (prior) disposeEntry(prior);
  sessions.set(key, entry);

  emitPhase(entry, "idle", "agent session created");

  return entry;
}

/**
 * Ensure a registry entry exists for a session that already has disk meta
 * (e.g. server restarted, or create from another process).
 */
export async function ensureRegistered(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<RegisteredAgentSession> {
  const existing = getRegisteredAgentSession(workspace.id, sessionId);
  if (existing) return existing;

  const workspaceRoot = path.resolve(workspace.rootPath);
  const onDisk = await agentSessionExistsOnDisk(workspaceRoot, sessionId);
  if (!onDisk) {
    throw new Error(`agent session not found: ${sessionId}`);
  }

  const sessionWorkDir = piSessionPath(workspaceRoot, sessionId);
  await mkdir(sessionWorkDir, { recursive: true });

  const entry: RegisteredAgentSession = {
    sessionId,
    workspaceId: workspace.id,
    workspaceRoot,
    workspaceName: workspace.name,
    title: `Wiki Agent · ${workspace.name}`,
    createdAt: nowIso(),
    metaPath: sessionMetaPath(workspaceRoot, sessionId),
    sessionWorkDir,
    busy: false,
  };
  sessions.set(regKey(workspace.id, sessionId), entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Live Pi chat session
// ---------------------------------------------------------------------------

async function ensureLiveHandle(
  entry: RegisteredAgentSession,
  role: "operator_chat" | "root_research" = "operator_chat",
): Promise<WikiSessionHandle> {
  if (entry.handle) return entry.handle;

  const handle = await createWikiSession({
    role,
    runWorkDir: entry.sessionWorkDir,
    // Durable Pi JSONL under workspace .okf-wiki/pi-sessions/ (ADR 0030).
    workspaceRoot: entry.workspaceRoot,
    // Model omitted: offline-safe construction; prompt only when not fixture.
  });

  entry.unsubPi = handle.session.subscribe((event) => {
    const kind =
      event && typeof event === "object" && "type" in event
        ? String((event as { type: unknown }).type)
        : "event";
    emitPi(entry.workspaceId, entry.sessionId, kind, event);
  });

  entry.handle = handle;
  emitPi(entry.workspaceId, entry.sessionId, "session_ready", {
    role: handle.role,
    tools: [...handle.tools],
    runWorkDir: handle.runWorkDir,
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Produce path
// ---------------------------------------------------------------------------

async function buildMaterializeInput(
  workspace: WorkspaceConfig,
): Promise<
  | {
      sources: Map<string, string>;
      skillRoot: string;
      reset: boolean;
    }
  | undefined
> {
  try {
    const skillRoot = await resolveSkillPath({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const sources = new Map<string, string>();
    for (const src of workspace.sources) {
      sources.set(src.id, src.path);
    }
    return { sources, skillRoot, reset: true };
  } catch {
    // Skill resolve failed — produce without materialize (wiki/analysis only).
    return undefined;
  }
}

/**
 * After plan is approved (or skipped): mark producing → produceWithPi →
 * hard-validate → awaiting publish.
 */
async function runProducePhase(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
): Promise<void> {
  if (!entry.shell) {
    throw new Error("no shell state for produce");
  }
  if (!entry.runId) {
    throw new Error("no runId for produce");
  }

  entry.shell = markProducing(entry.shell);
  emitPhase(entry, "writing", "producing wiki (Pi)", "running");

  const runWorkDir = piRunWorkDir(entry.workspaceRoot, entry.runId);
  const materialize = await buildMaterializeInput(workspace);
  const fixture = preferPiFixture();

  const controller = new AbortController();
  entry.abortController = controller;

  try {
    const result = await produceWithPi({
      runWorkDir,
      role: "root_write",
      fixture,
      title: entry.shell.plan?.summary ?? workspace.name,
      materialize,
      abortSignal: controller.signal,
    });

    entry.shell = markHardValidate(
      entry.shell,
      result.pages,
      result.summary,
    );
    emitPhase(
      entry,
      "writing",
      result.summary,
      "running",
    );

    entry.shell = markAwaitingPublish(
      entry.shell,
      result.pages,
      result.summary,
    );
    emitRunLink(entry, "awaiting_publication");
    emitGate(
      entry,
      "publication",
      "Review produced pages and approve publication",
      entry.shell.plan,
      result.pages,
    );
    emitPhase(
      entry,
      "awaiting_publish",
      result.summary,
      "awaiting_publication",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled =
      controller.signal.aborted ||
      (err instanceof Error &&
        (err.name === "AbortError" || /cancelled/i.test(err.message)));
    if (cancelled) {
      entry.shell = markCancelled(entry.shell, "Wiki Run cancelled");
      emitPhase(entry, "cancelled", "Wiki Run cancelled", "cancelled");
    } else {
      entry.shell = markFailed(entry.shell, message);
      emitPhase(entry, "failed", message, "failed");
    }
  } finally {
    entry.abortController = undefined;
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

export async function dispatchAgentCommand(
  workspace: WorkspaceConfig,
  sessionId: string,
  command: AgentCommand,
): Promise<AgentCommandResponse> {
  const entry = await ensureRegistered(workspace, sessionId);

  switch (command.type) {
    case "prompt":
      return handlePrompt(entry, command.text);
    case "steer":
      return handleSteer(entry, command.text);
    case "abort":
      return handleAbort(entry);
    case "compact":
      return handleCompact(entry);
    case "start_wiki_run":
      return handleStartWikiRun(entry, workspace, command);
    case "resume_gate":
      return handleResumeGate(entry, workspace, command);
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

async function handlePrompt(
  entry: RegisteredAgentSession,
  text: string,
): Promise<AgentCommandResponse> {
  const handle = await ensureLiveHandle(entry, "operator_chat");
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
      ok: true,
      sessionId: entry.sessionId,
      command: "prompt",
      status: "accepted",
      message: `prompt failed: ${message}`,
    };
  } finally {
    entry.busy = false;
  }
}

async function handleSteer(
  entry: RegisteredAgentSession,
  text: string,
): Promise<AgentCommandResponse> {
  const handle = await ensureLiveHandle(entry, "operator_chat");
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
      ok: true,
      sessionId: entry.sessionId,
      command: "steer",
      status: "accepted",
      message: `steer failed: ${message}`,
    };
  }
}

async function handleAbort(
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

async function handleCompact(
  entry: RegisteredAgentSession,
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
  await ensureLiveHandle(entry, "operator_chat");
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

async function handleStartWikiRun(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  command: Extract<AgentCommand, { type: "start_wiki_run" }>,
): Promise<AgentCommandResponse> {
  if (entry.busy) {
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "start_wiki_run",
      status: "accepted",
      message: "session busy; start_wiki_run ignored",
      runId: entry.runId,
    };
  }

  const runId = randomUUID();
  entry.runId = runId;

  const plan = defaultWikiRunSpec(workspace.name);
  if (command.notes?.trim()) {
    plan.notes = [plan.notes, command.notes.trim()].filter(Boolean).join("\n\n");
    plan.changelog = [...(plan.changelog ?? []), "Operator notes on start"].slice(
      -20,
    );
  }

  const skipPlanConfirm =
    command.autoApprove === true || workspace.planConfirm === false;

  entry.shell = startShell({
    plan,
    skipPlanConfirm,
    summary: plan.summary,
  });

  emitRunLink(entry, statusFromShell(entry.shell.phase));
  emitPhase(
    entry,
    "planning",
    command.notes ?? "start_wiki_run",
    "running",
  );

  if (entry.shell.phase === "awaiting_plan") {
    emitGate(
      entry,
      "plan",
      "Review and confirm the wiki Spec before produce",
      entry.shell.plan,
    );
    emitPhase(
      entry,
      "awaiting_plan",
      "awaiting plan confirmation",
      "awaiting_plan",
    );
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "start_wiki_run",
      status: "accepted",
      message: "Wiki run started — awaiting plan gate",
      runId,
    };
  }

  // Plan gate skipped — produce immediately (fixture by default).
  entry.busy = true;
  try {
    await runProducePhase(entry, workspace);
  } finally {
    entry.busy = false;
  }

  return {
    ok: true,
    sessionId: entry.sessionId,
    command: "start_wiki_run",
    status: "accepted",
    message: preferPiFixture()
      ? "Wiki run produced in fixture mode — awaiting publication"
      : "Wiki run produce finished — awaiting publication",
    runId,
  };
}

async function handleResumeGate(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  command: Extract<AgentCommand, { type: "resume_gate" }>,
): Promise<AgentCommandResponse> {
  if (!entry.shell) {
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "resume_gate",
      status: "accepted",
      message: "no active shell — resume ignored",
      runId: command.runId ?? entry.runId,
    };
  }

  if (command.runId) {
    entry.runId = command.runId;
  }

  const step = command.gate === "publication" ? "publish" : "plan";

  try {
    entry.shell = resumeGate(entry.shell, {
      step,
      action: command.action,
      plan: command.plan,
      feedback: command.feedback,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitPi(entry.workspaceId, entry.sessionId, "error", { message });
    return {
      ok: true,
      sessionId: entry.sessionId,
      command: "resume_gate",
      status: "accepted",
      message: `resume_gate rejected: ${message}`,
      runId: entry.runId,
    };
  }

  emitGate(
    entry,
    command.gate,
    `resume_gate ${command.action}`,
    entry.shell.plan,
    entry.shell.pages,
  );

  const shellPhase = entry.shell.phase;
  emitPhase(
    entry,
    productPhaseFromShell(shellPhase),
    `gate ${command.gate} → ${command.action}`,
    statusFromShell(shellPhase),
  );
  emitRunLink(entry, statusFromShell(shellPhase));

  // Plan approved → shell idle with plan → produce.
  if (
    command.gate === "plan" &&
    command.action === "approve" &&
    shellPhase === "idle" &&
    entry.shell.plan
  ) {
    entry.busy = true;
    try {
      await runProducePhase(entry, workspace);
    } finally {
      entry.busy = false;
    }
  }

  return {
    ok: true,
    sessionId: entry.sessionId,
    command: "resume_gate",
    status: "accepted",
    message: `gate ${command.gate} ${command.action} → ${entry.shell.phase}`,
    runId: entry.runId,
  };
}
