/**
 * In-process registry for Pi agent sessions (ADR 0030).
 *
 * Maps sessionId → live WikiSessionHandle (when created), WikiRunShell state,
 * and workspace root. Routes stay thin; this module owns command side-effects.
 *
 * Implementation is split under `./session/` for maintainability.
 * This module keeps the registry map + public re-exports used by routes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { piSessionPath } from "@okf-wiki/agent";
import {
  type AgentCommand,
  type AgentCommandResponse,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { isPathInside } from "@okf-wiki/core";
import { emitPhase } from "./session/product-inject.ts";
import {
  handleAbort,
  handleCompact,
  handlePrompt,
  handleResumeGate,
  handleStartWikiRun,
  handleSteer,
} from "./session/commands.ts";
import {
  agentSessionExistsOnDisk,
  ensurePiSessionsDir,
  nowIso,
  readSessionMeta,
  sessionMetaPath,
  type RegisteredAgentSession,
} from "./session/parent-session.ts";

// ---------------------------------------------------------------------------
// Public types + path / history helpers (re-exported for routes / tests)
// ---------------------------------------------------------------------------

export type { RegisteredAgentSession } from "./session/parent-session.ts";
export {
  agentSessionExistsOnDisk,
  ensurePiSessionsDir,
  preferPiFixture,
  resolveSessionHistoryFile,
  sessionMetaPath,
} from "./session/parent-session.ts";

// Re-export session helpers used by routes / tests.
export {
  foldWorkUnits,
  lastRunPhase,
  loadTrajectory,
  operatorTrajectoryPath,
} from "./session/trajectory-store.ts";
export {
  productPhaseFromShell,
  resolveColdLoadPhase,
} from "./session/produce-adapter.ts";

// ---------------------------------------------------------------------------
// Registry CRUD
// ---------------------------------------------------------------------------

const sessions = new Map<string, RegisteredAgentSession>();

function regKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}

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
