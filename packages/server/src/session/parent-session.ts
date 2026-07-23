/**
 * Parent Pi session lifecycle: meta paths, live handle, produce model helpers.
 *
 * Extracted from agent-session-registry for maintainability (no behavior change).
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createWikiSession,
  findPiSessionFile,
  piSessionPath,
  piSessionsDir,
  resolveModelSelection,
  resolveWikiSkillPaths,
  resolveWorkspacePiModel,
  shouldUsePiFixtureMode,
  type ResolvedPiModel,
  type WikiModelRole,
  type WikiRunModelFactory,
  type WikiRunShellState,
  type WikiSessionHandle,
  type WikiWorkflowTerminal,
} from "@okf-wiki/agent";
import { type WorkspaceConfig } from "@okf-wiki/contract";
import {
  isPathInside,
  updateRunRecord,
} from "@okf-wiki/core";
import {
  emitGate,
  emitPhase,
  emitRunLink,
} from "./product-inject.ts";
import { emitPi } from "./produce-adapter.ts";

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

export function nowIso(): string {
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

export async function readSessionMeta(
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
export async function writeSessionMetaSessionFile(
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
// Live Pi chat session
// ---------------------------------------------------------------------------

/**
 * Resolve workspace / role / override → Pi Model + ModelRuntime.
 * Uses Settings provider catalog (openai-compatible only today).
 */
export async function resolvePiModelForWorkspace(
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

export async function skillPathsForWorkspace(
  workspace: WorkspaceConfig,
): Promise<string[]> {
  return resolveWikiSkillPaths({
    workspaceRoot: workspace.rootPath,
    skillPath: workspace.skillPath,
  });
}

export async function ensureLiveHandle(
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

export function makeResolveModel(
  workspace: WorkspaceConfig,
  entry: RegisteredAgentSession,
): WikiRunModelFactory {
  return async (role) => {
    const piRole =
      role === "planner"
        ? "planner"
        : role === "worker"
          ? "worker"
          : role === "reviewer"
            ? "reviewer"
            : "writer";
    const piModel = await resolvePiModelForWorkspace(workspace, {
      role: piRole,
      // Operator override applies to writer path; other roles keep roleModels.
      overrideProfileId:
        piRole === "writer" ? entry.produceModelProfileId : undefined,
    });
    emitPi(entry.workspaceId, entry.sessionId, "produce_model", {
      providerId: piModel.providerId,
      modelId: piModel.servedModelId,
      providerKind: piModel.providerKind,
      profileId: piModel.runtime.profileId,
      maxContextTokens: piModel.runtime.maxContextTokens,
      overrideProfileId: entry.produceModelProfileId,
      role: piRole,
    });
    return {
      model: piModel.model,
      modelRuntime: piModel.modelRuntime,
      maxContextTokens: piModel.runtime.maxContextTokens,
      profileId: piModel.runtime.profileId,
    };
  };
}

export async function persistTerminal(
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
