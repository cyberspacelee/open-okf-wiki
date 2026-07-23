/**
 * In-process registry for Pi agent sessions (ADR 0030).
 *
 * Maps sessionId → live WikiSessionHandle (when created), WikiRunShell state,
 * and workspace root. Routes stay thin; this module owns command side-effects.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createWikiSession,
  findPiSessionFile,
  isTerminalPhase,
  markCancelled,
  markFailed,
  piSessionPath,
  piSessionsDir,
  resolveModelSelection,
  resolveWikiSkillPaths,
  resolveWorkspacePiModel,
  resumeWikiRun,
  shouldUsePiFixtureMode,
  startWikiRun,
  type ResolvedPiModel,
  type WikiModelRole,
  type WikiRunModelFactory,
  type WikiRunShellState,
  type WikiSessionHandle,
  type WikiWorkflowTerminal,
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
import {
  freezeWikiRun,
  FreezeWikiRunError,
  isPathInside,
  updateRunRecord,
} from "@okf-wiki/core";
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
  /**
   * Absolute Pi JSONL path once known (written into meta on first live handle).
   * History cold-load and live resume both prefer this path (pi-web pattern).
   */
  sessionFile?: string;
  /** Live Pi handle for operator chat (lazily created on first prompt/steer). */
  handle?: WikiSessionHandle;
  /** Unsubscribe from Pi session events. */
  unsubPi?: () => void;
  /** Active WikiRunShell state when a run has been started. */
  shell?: WikiRunShellState;
  runId?: string;
  /**
   * Optional model profile override for the current wiki produce
   * (from start_wiki_run.modelProfileId). Cleared when produce finishes.
   */
  produceModelProfileId?: string;
  /** Abort controller for in-flight produce. */
  abortController?: AbortController;
  /** True while prompt/produce is running. */
  busy: boolean;
};

type SessionMetaDisk = {
  schema?: string;
  id?: string;
  workspaceId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  sessionWorkDir?: string;
  sessionFile?: string;
  stub?: boolean;
};

async function readSessionMeta(
  metaPath: string,
): Promise<SessionMetaDisk | null> {
  try {
    const raw = await readFile(metaPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SessionMetaDisk;
  } catch {
    return null;
  }
}

/** Persist / refresh sessionFile on product meta so cold history can find Pi JSONL. */
async function writeSessionMetaSessionFile(
  entry: RegisteredAgentSession,
  sessionFile: string,
): Promise<void> {
  entry.sessionFile = sessionFile;
  const existing = (await readSessionMeta(entry.metaPath)) ?? {
    schema: "okf.pi-session/v1",
    id: entry.sessionId,
    workspaceId: entry.workspaceId,
    title: entry.title,
    createdAt: entry.createdAt,
    sessionWorkDir: entry.sessionWorkDir,
    stub: false,
  };
  const next: SessionMetaDisk = {
    ...existing,
    id: entry.sessionId,
    workspaceId: entry.workspaceId,
    title: entry.title,
    createdAt: existing.createdAt ?? entry.createdAt,
    updatedAt: nowIso(),
    sessionWorkDir: entry.sessionWorkDir,
    sessionFile,
    stub: false,
  };
  await writeFile(entry.metaPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

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

/**
 * Resolve the preferred Pi JSONL path for cold history load.
 * Order: live handle → in-memory meta → disk meta → discovery scan.
 */
export async function resolveSessionHistoryFile(
  workspaceRoot: string,
  sessionId: string,
  reg?: RegisteredAgentSession | null,
): Promise<string | null> {
  const preferred =
    reg?.handle?.sessionFile ??
    reg?.sessionFile ??
    (await readSessionMeta(sessionMetaPath(workspaceRoot, sessionId)))
      ?.sessionFile;
  return findPiSessionFile(workspaceRoot, sessionId, {
    preferredPath: preferred,
  });
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

  const metaPath = sessionMetaPath(workspaceRoot, sessionId);
  const diskMeta = await readSessionMeta(metaPath);
  const entry: RegisteredAgentSession = {
    sessionId,
    workspaceId: workspace.id,
    workspaceRoot,
    workspaceName: workspace.name,
    title: diskMeta?.title?.trim() || `Wiki Agent · ${workspace.name}`,
    createdAt: diskMeta?.createdAt ?? nowIso(),
    metaPath,
    sessionWorkDir,
    sessionFile: diskMeta?.sessionFile,
    busy: false,
  };
  sessions.set(regKey(workspace.id, sessionId), entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Live Pi chat session
// ---------------------------------------------------------------------------

/**
 * Resolve workspace / role / override → Pi Model + ModelRuntime.
 * Uses Settings provider catalog (openai-compatible only today).
 */
async function resolvePiModelForWorkspace(
  workspace: WorkspaceConfig,
  options: {
    role?: WikiModelRole;
    overrideProfileId?: string;
  } = {},
): Promise<ResolvedPiModel> {
  const selection = resolveModelSelection({
    workspace,
    role: options.role ?? "default",
    overrideProfileId: options.overrideProfileId,
  });
  return resolveWorkspacePiModel({
    profileId: selection.profileId,
    modelId: selection.id,
  });
}

async function skillPathsForWorkspace(
  workspace: WorkspaceConfig,
): Promise<string[]> {
  return resolveWikiSkillPaths({
    workspaceRoot: workspace.rootPath,
    skillPath: workspace.skillPath,
  });
}

async function ensureLiveHandle(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  role: "operator_chat" | "root_research" = "operator_chat",
): Promise<WikiSessionHandle> {
  if (entry.handle) return entry.handle;

  // Fixture mode: offline-safe session (no model). Live needs provider catalog.
  let model: ResolvedPiModel | undefined;
  if (!preferPiFixture()) {
    model = await resolvePiModelForWorkspace(workspace, { role: "default" });
  }

  const skillPaths = await skillPathsForWorkspace(workspace);
  const contextTargetTokens = workspace.limits?.contextTargetTokens;
  const maxContextTokens = model?.runtime.maxContextTokens;

  // Resume existing Pi JSONL when present (same product sessionId). Without this
  // every process restart SessionManager.create()'d a new empty file and history
  // cold-load could not find the previous turn (pi-web opens by path/id).
  const existingFile =
    entry.sessionFile ??
    (await findPiSessionFile(entry.workspaceRoot, entry.sessionId, {
      preferredPath: entry.sessionFile,
    }));

  const handle = await createWikiSession({
    role,
    runWorkDir: entry.sessionWorkDir,
    // Durable Pi JSONL under workspace .okf-wiki/pi-sessions/ (ADR 0030).
    workspaceRoot: entry.workspaceRoot,
    sessionId: entry.sessionId,
    ...(existingFile ? { sessionFile: existingFile } : {}),
    contextTargetTokens,
    maxContextTokens,
    additionalSkillPaths: skillPaths,
    ...(model
      ? { model: model.model, modelRuntime: model.modelRuntime }
      : {}),
  });

  if (handle.sessionFile) {
    try {
      await writeSessionMetaSessionFile(entry, handle.sessionFile);
    } catch {
      // Meta write failure must not block the live session.
      entry.sessionFile = handle.sessionFile;
    }
  }

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
    sessionFile: handle.sessionFile,
    skillPathCount: skillPaths.length,
    contextTarget: handle.contextBudget?.contextTarget,
    contextWindow: handle.contextBudget?.contextWindow,
    ...(model
      ? {
          providerId: model.providerId,
          modelId: model.servedModelId,
          providerKind: model.providerKind,
          profileId: model.runtime.profileId,
          maxContextTokens: model.runtime.maxContextTokens,
        }
      : { fixture: true }),
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Wiki Run orchestration adapter (thin over startWikiRun / resumeWikiRun)
// ---------------------------------------------------------------------------

function makeResolveModel(
  workspace: WorkspaceConfig,
  entry: RegisteredAgentSession,
): WikiRunModelFactory {
  return async () => {
    const piModel = await resolvePiModelForWorkspace(workspace, {
      role: "writer",
      overrideProfileId: entry.produceModelProfileId,
    });
    emitPi(entry.workspaceId, entry.sessionId, "produce_model", {
      providerId: piModel.providerId,
      modelId: piModel.servedModelId,
      providerKind: piModel.providerKind,
      profileId: piModel.runtime.profileId,
      maxContextTokens: piModel.runtime.maxContextTokens,
      overrideProfileId: entry.produceModelProfileId,
    });
    return {
      model: piModel.model,
      modelRuntime: piModel.modelRuntime,
      maxContextTokens: piModel.runtime.maxContextTokens,
      profileId: piModel.runtime.profileId,
    };
  };
}

function mapOrchestratorOnEvent(
  entry: RegisteredAgentSession,
): (event: { type: string; message?: string; data?: unknown }) => void {
  return (event) => {
    const ts = nowIso();
    if (event.type === "gate") {
      const gate =
        event.message === "awaiting_plan" || event.message === "plan"
          ? "plan"
          : "publication";
      const data = (event.data ?? {}) as {
        plan?: WikiRunPlan;
        pages?: string[];
      };
      emitGate(
        entry,
        gate,
        gate === "plan"
          ? "Review and confirm the wiki Spec before produce"
          : "Review produced pages and approve publication",
        data.plan ?? entry.shell?.plan,
        data.pages ?? entry.shell?.pages,
      );
      emitPhase(
        entry,
        gate === "plan" ? "awaiting_plan" : "awaiting_publish",
        event.message,
        gate === "plan" ? "awaiting_plan" : "awaiting_publication",
      );
      emitRunLink(
        entry,
        gate === "plan" ? "awaiting_plan" : "awaiting_publication",
      );
      return;
    }
    if (event.type === "phase") {
      const msg = event.message ?? "";
      const data = (event.data ?? {}) as { label?: string };
      if (
        msg === "planning" ||
        msg === "researching" ||
        msg === "writing" ||
        msg === "reviewing" ||
        msg === "repairing" ||
        msg === "done" ||
        msg === "failed"
      ) {
        emitProductAgentEvent(entry.workspaceId, {
          source: "product",
          kind: "progress",
          sessionId: entry.sessionId,
          runId: entry.runId,
          phase: msg,
          label: data.label ?? event.message,
          timestamp: ts,
        });
      }
      if (msg === "producing" || msg === "writing" || msg === "researching") {
        emitPhase(entry, "writing", data.label ?? msg, "running");
        emitRunLink(entry, "running");
      } else if (msg === "hard_validate") {
        emitPhase(entry, "writing", "hard-validate", "running");
      } else if (msg === "published" || msg === "done") {
        emitPhase(entry, "done", "published", "published");
        emitRunLink(entry, "published");
      } else if (msg === "failed") {
        emitPhase(entry, "failed", data.label ?? msg, "failed");
      } else {
        emitPhase(entry, productPhaseFromShell(entry.shell?.phase ?? "idle"), msg);
      }
      return;
    }
    if (event.type === "agent_span") {
      const data = (event.data ?? {}) as {
        spanId?: string;
        agentId?: string;
        role?: "domain" | "leaf" | "reviewer" | "root";
        status?: "running" | "complete" | "failed";
        promptSummary?: string;
        runId?: string;
      };
      if (data.spanId && data.agentId && data.role && data.status) {
        emitProductAgentEvent(entry.workspaceId, {
          source: "product",
          kind: "agent_span",
          sessionId: entry.sessionId,
          runId: data.runId ?? entry.runId,
          spanId: data.spanId,
          agentId: data.agentId,
          role: data.role,
          status: data.status,
          promptSummary: data.promptSummary,
          timestamp: ts,
        });
      }
      return;
    }
    if (event.type === "defects") {
      const data = (event.data ?? {}) as {
        round?: number;
        clean?: boolean;
        defectCount?: number;
        summary?: string;
      };
      emitProductAgentEvent(entry.workspaceId, {
        source: "product",
        kind: "defects",
        sessionId: entry.sessionId,
        runId: entry.runId,
        round: data.round ?? 1,
        clean: data.clean ?? true,
        defectCount: data.defectCount ?? 0,
        summary: data.summary,
        timestamp: ts,
      });
      return;
    }
    if (event.type === "error") {
      emitPi(entry.workspaceId, entry.sessionId, "error", {
        message: event.message,
        data: event.data,
      });
    }
  };
}

async function persistTerminal(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  result: WikiWorkflowTerminal,
): Promise<void> {
  if (result.shell) {
    entry.shell = result.shell;
  }
  if (!entry.runId) return;
  try {
    await updateRunRecord(workspace.rootPath, entry.runId, {
      status: result.status,
      pages: result.pages ?? null,
      summary: result.summary ?? null,
      error: result.error ?? null,
      plan: result.plan ?? null,
    });
  } catch {
    // best-effort; SSE still carries status
  }
  emitRunLink(entry, result.status);
  if (result.status === "failed" || result.status === "cancelled") {
    emitPhase(
      entry,
      result.status === "cancelled" ? "cancelled" : "failed",
      result.summary ?? result.error,
      result.status,
    );
  } else if (result.status === "awaiting_publication") {
    emitGate(
      entry,
      "publication",
      "Review produced pages and approve publication",
      result.plan ?? entry.shell?.plan,
      result.pages,
    );
    emitPhase(
      entry,
      "awaiting_publish",
      result.summary,
      "awaiting_publication",
    );
  } else if (result.status === "published") {
    emitPhase(entry, "done", result.summary ?? "published", "published");
  } else if (result.status === "publication_declined") {
    emitPhase(
      entry,
      "done",
      result.summary ?? "publication declined",
      "publication_declined",
    );
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
      return handlePrompt(entry, workspace, command.text);
    case "steer":
      return handleSteer(entry, workspace, command.text);
    case "abort":
      return handleAbort(entry);
    case "compact":
      return handleCompact(entry, workspace);
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

async function handlePrompt(
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

async function handleSteer(
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

async function handleStartWikiRun(
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

  const plan = defaultWikiRunSpec(workspace.name);
  if (command.notes?.trim()) {
    plan.notes = [plan.notes, command.notes.trim()].filter(Boolean).join("\n\n");
    plan.changelog = [...(plan.changelog ?? []), "Operator notes on start"].slice(
      -20,
    );
  }
  if (entry.produceModelProfileId) {
    plan.changelog = [
      ...(plan.changelog ?? []),
      `Model profile: ${entry.produceModelProfileId}`,
    ].slice(-20);
  }

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
    plan,
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

  // Plan gate: await (returns quickly). Skip-plan produce: background so SSE can stream.
  if (!skipPlanConfirm) {
    try {
      const result = await startWikiRun(runOpts);
      if (result.shell) entry.shell = result.shell;
      await persistTerminal(entry, workspace, result);
      entry.abortController = undefined;
      return {
        ok: true,
        sessionId: entry.sessionId,
        command: "start_wiki_run",
        status: "accepted",
        message:
          result.suspendGate === "plan"
            ? "Wiki run started — awaiting plan gate"
            : `Wiki run ${result.status}`,
        runId: frozen.runId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitPi(entry.workspaceId, entry.sessionId, "error", { message });
      entry.abortController = undefined;
      return {
        ok: false,
        sessionId: entry.sessionId,
        command: "start_wiki_run",
        status: "failed",
        message: `start failed: ${message}`,
        runId: frozen.runId,
      };
    }
  }

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
    message: preferPiFixture()
      ? "Wiki run produce started (fixture mode)"
      : "Wiki run produce started",
    runId: frozen.runId,
  };
}

async function handleResumeGate(
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
