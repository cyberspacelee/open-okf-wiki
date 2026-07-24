/** Live-handle cache around the Pi-native Operator Session module (ADR 0032). */

import {
  createOperatorFixtureModel,
  createOperatorSession,
  deleteOperatorSession,
  loadOperatorSessionHistory,
  type OperatorSessionHistory,
  openOperatorSession,
  redactErrorMessage,
  redactSensitiveValue,
  resolveModelSelection,
  resolveWorkspacePiModel,
  shouldUsePiFixtureMode,
  type WikiProduceGateCoordinator,
  type WikiProduceGateDecision,
  type WikiProduceGateRequest,
} from "@okf-wiki/agent";
import {
  type AgentCommand,
  type AgentCommandResponse,
  type AgentSseActiveTool,
  type PiAgentSseEvent,
  WikiProduceToolDetailsSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { loadWorkspaceById, resolveWikiSkillPaths } from "@okf-wiki/core";
import { emitAgentSessionEvent } from "./agent-session-events.ts";

type OperatorSessionHandle = Awaited<ReturnType<typeof createOperatorSession>>;

export type RegisteredAgentSession = {
  handle: OperatorSessionHandle;
  workspaceId: string;
  busy: boolean;
  unsubscribe: () => void;
  activeTool?: AgentSseActiveTool;
  queueFixtureTurn?: (text: string, canProduce: boolean) => void;
};

export type LiveAgentSessionSummary = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

type PendingGate = {
  request: WikiProduceGateRequest;
  resolve: (decision: WikiProduceGateDecision) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
};

/**
 * Bound wait for abort/idle before cascading Session delete.
 * Fail-open: if the session never reports idle within this window, delete still
 * proceeds (dispose + disk cascade) rather than hanging forever.
 */
const DELETE_SETTLE_TIMEOUT_MS = 5_000;
const DELETE_SETTLE_POLL_MS = 25;

const liveSessions = new Map<string, RegisteredAgentSession>();
const pendingGates = new Map<string, PendingGate>();
/** Single-flight open for cold ensureRegistered (one SessionManager per JSONL). */
const openingSessions = new Map<string, Promise<RegisteredAgentSession>>();
/**
 * Single-flight delete per key (mirrors openingSessions). Concurrent deletes await
 * the same promise; create/open check `.has(key)` so they cannot registerLive while
 * a cascade is in progress. Cleared only when that flight finishes.
 */
const deletingSessions = new Map<string, Promise<{ sessionId: string; removed: number }>>();

function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}

function titleFromPrompt(text: string, max = 60): string | undefined {
  const firstLine = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function defaultTitle(workspace: WorkspaceConfig): string {
  return `Wiki Agent · ${workspace.name.trim() || "workspace"}`;
}

function disposeLive(entry: RegisteredAgentSession): void {
  try {
    entry.unsubscribe();
  } catch {
    // Already detached.
  }
  try {
    entry.handle.dispose();
  } catch {
    // Already disposed.
  }
}

function activeToolUpdate(event: unknown): AgentSseActiveTool | null | undefined {
  if (!event || typeof event !== "object") return undefined;
  const body = event as Record<string, unknown>;
  if (
    body.type === "tool_execution_end" ||
    body.type === "agent_end" ||
    body.type === "agent_settled"
  ) {
    return null;
  }
  if (body.type === "tool_execution_start") return null;
  if (body.type !== "tool_execution_update") return undefined;

  const partial = body.partialResult;
  if (!partial || typeof partial !== "object") return undefined;
  const parsed = WikiProduceToolDetailsSchema.safeParse(
    (partial as Record<string, unknown>).details,
  );
  if (!parsed.success || typeof body.toolCallId !== "string" || typeof body.toolName !== "string") {
    return undefined;
  }
  return {
    toolCallId: body.toolCallId,
    toolName: body.toolName,
    details: parsed.data,
  };
}

function registerLive(
  workspaceId: string,
  handle: OperatorSessionHandle,
  queueFixtureTurn?: (text: string, canProduce: boolean) => void,
): RegisteredAgentSession {
  const key = sessionKey(workspaceId, handle.sessionId);
  const prior = liveSessions.get(key);
  if (prior) disposeLive(prior);

  const entry: RegisteredAgentSession = {
    handle,
    workspaceId,
    busy: false,
    unsubscribe: () => undefined,
    ...(queueFixtureTurn ? { queueFixtureTurn } : {}),
  };
  entry.unsubscribe = handle.session.subscribe((event) => {
    const activeTool = activeToolUpdate(event);
    if (activeTool === null) delete entry.activeTool;
    else if (activeTool) entry.activeTool = activeTool;
    const kind = event.type;
    // Redact before fan-out so operator SSE never carries raw secrets/paths.
    emitAgentSessionEvent(workspaceId, handle.sessionId, {
      source: "pi",
      kind,
      sessionId: handle.sessionId,
      payload: redactSensitiveValue(event),
      timestamp: new Date().toISOString(),
    } satisfies PiAgentSseEvent);
  });
  liveSessions.set(key, entry);
  return entry;
}

function projectLiveSession(entry: RegisteredAgentSession): LiveAgentSessionSummary {
  const manager = entry.handle.session.sessionManager;
  const header = manager.getHeader();
  if (!header) throw new Error("Pi did not initialize the Operator Session");
  return {
    id: manager.getSessionId(),
    title: manager.getSessionName()?.trim() || undefined,
    createdAt: header.timestamp,
    updatedAt: manager.getBranch().at(-1)?.timestamp ?? header.timestamp,
  };
}

function gateCoordinator(workspaceId: string, sessionId: string): WikiProduceGateCoordinator {
  return {
    waitForDecision(request, signal) {
      const key = sessionKey(workspaceId, sessionId);
      if (pendingGates.has(key)) {
        return Promise.reject(new Error("Operator Session already has a pending Wiki Run gate"));
      }
      return new Promise<WikiProduceGateDecision>((resolve, reject) => {
        const pending: PendingGate = {
          request,
          resolve: (decision) => {
            pending.detachAbort?.();
            pendingGates.delete(key);
            resolve(decision);
          },
          reject: (error) => {
            pending.detachAbort?.();
            pendingGates.delete(key);
            reject(error);
          },
        };
        if (signal) {
          const abort = () => pending.reject(new Error("Wiki Run cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          pending.detachAbort = () => signal.removeEventListener("abort", abort);
        }
        pendingGates.set(key, pending);
      });
    },
  };
}

async function resolveRoleModel(
  workspace: WorkspaceConfig,
  role: "default" | "planner" | "worker" | "writer" | "reviewer",
) {
  const selected = resolveModelSelection({ workspace, role });
  return resolveWorkspacePiModel({
    profileId: selected.profileId,
    modelId: selected.id,
  });
}

async function reloadWorkspace(workspace: WorkspaceConfig): Promise<WorkspaceConfig> {
  const current = await loadWorkspaceById(workspace.id, { rootPath: workspace.rootPath });
  if (!current) {
    throw new Error(`Workspace not found while starting Wiki Run: ${workspace.id}`);
  }
  return current;
}

async function runtimeInput(workspace: WorkspaceConfig, sessionId?: string) {
  const fixture = shouldUsePiFixtureMode({});
  const fixtureModel = fixture ? await createOperatorFixtureModel() : undefined;
  const operatorModel = fixtureModel ? undefined : await resolveRoleModel(workspace, "default");
  const skillPaths = await resolveWikiSkillPaths({
    workspaceRoot: workspace.rootPath,
    skillPath: workspace.skillPath,
  });
  return {
    input: {
      workspace,
      ...(sessionId ? { sessionId } : {}),
      ...(fixtureModel
        ? { model: fixtureModel.model, modelRuntime: fixtureModel.modelRuntime }
        : operatorModel
          ? { model: operatorModel.model, modelRuntime: operatorModel.modelRuntime }
          : {}),
      additionalSkillPaths: skillPaths,
      contextTargetTokens: workspace.limits?.contextTargetTokens,
      maxContextTokens: operatorModel?.runtime.maxContextTokens,
      wikiProduce: {
        gateCoordinator: gateCoordinator(workspace.id, sessionId ?? "pending"),
        resolveWorkspace: () => reloadWorkspace(workspace),
        fixture,
        resolveModel: fixture
          ? undefined
          : async (
              role: "planner" | "worker" | "writer" | "reviewer",
              currentWorkspace: WorkspaceConfig,
            ) => {
              const resolved = await resolveRoleModel(currentWorkspace, role);
              return {
                model: resolved.model,
                modelRuntime: resolved.modelRuntime,
                maxContextTokens: resolved.runtime.maxContextTokens,
              };
            },
      },
    },
    queueFixtureTurn: fixtureModel
      ? (text: string, canProduce: boolean) => {
          if (canProduce) fixtureModel.queueWikiProduceTurn(text);
          else fixtureModel.queueAssistantTurn();
        }
      : undefined,
  };
}

/** Create a Pi-native SessionManager session and cache its live AgentSession. */
export async function registerAgentSession(input: {
  workspace: WorkspaceConfig;
  sessionId?: string;
  title?: string;
}): Promise<LiveAgentSessionSummary> {
  const requestedId = input.sessionId?.trim();
  if (requestedId) {
    const key = sessionKey(input.workspace.id, requestedId);
    // Delete barrier first: mid-cascade the dying live entry may still be present,
    // but create must report "being deleted" rather than "already exists".
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${requestedId}`);
    }
    if (liveSessions.has(key)) {
      throw new Error(`Operator Session already exists: ${requestedId}`);
    }
  }

  // A generated id must be known before constructing the gate coordinator. Pi
  // accepts an omitted id, so create once then bind the coordinator through a
  // stable wrapper that resolves the final id lazily.
  let resolvedSessionId = input.sessionId?.trim() ?? "";
  const coordinator: WikiProduceGateCoordinator = {
    waitForDecision(request, signal) {
      return gateCoordinator(input.workspace.id, resolvedSessionId).waitForDecision(
        request,
        signal,
      );
    },
  };
  const runtime = await runtimeInput(input.workspace, input.sessionId);
  // Re-check after await: a delete may have started for the requested id.
  if (requestedId && deletingSessions.has(sessionKey(input.workspace.id, requestedId))) {
    throw new Error(`Operator Session is being deleted: ${requestedId}`);
  }
  const handle = await createOperatorSession({
    ...runtime.input,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    wikiProduce: { ...runtime.input.wikiProduce, gateCoordinator: coordinator },
  });
  resolvedSessionId = handle.sessionId;
  // Final barrier before registerLive (covers client-chosen id races mid-create).
  if (deletingSessions.has(sessionKey(input.workspace.id, handle.sessionId))) {
    try {
      handle.dispose();
    } catch {
      // Already disposed.
    }
    throw new Error(`Operator Session is being deleted: ${handle.sessionId}`);
  }
  handle.session.setSessionName(input.title?.trim() || defaultTitle(input.workspace));
  return projectLiveSession(registerLive(input.workspace.id, handle, runtime.queueFixtureTurn));
}

/**
 * Open the exact SessionManager id; never scan legacy metadata or cwd stores.
 * Concurrent cold opens share one in-flight promise so only one SessionManager
 * is constructed against the JSONL. A concurrent delete wins: the open disposes
 * its handle and rejects rather than reanimating a deleted session.
 */
export async function ensureRegistered(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<RegisteredAgentSession> {
  const key = sessionKey(workspace.id, sessionId);
  if (deletingSessions.has(key)) {
    throw new Error(`Operator Session is being deleted: ${sessionId}`);
  }
  const existing = liveSessions.get(key);
  if (existing) return existing;

  const inFlight = openingSessions.get(key);
  if (inFlight) return inFlight;

  const openPromise = (async (): Promise<RegisteredAgentSession> => {
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${sessionId}`);
    }
    // Re-check after any prior await inside open; another path may have registered.
    const raced = liveSessions.get(key);
    if (raced) return raced;
    const runtime = await runtimeInput(workspace, sessionId);
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${sessionId}`);
    }
    const again = liveSessions.get(key);
    if (again) return again;
    const handle = await openOperatorSession({ ...runtime.input, sessionId });
    // Delete may have started while openOperatorSession was in flight. Dispose
    // immediately and reject so waiters never observe a resurrected live entry.
    if (deletingSessions.has(key)) {
      try {
        handle.dispose();
      } catch {
        // Already disposed.
      }
      throw new Error(`Operator Session was deleted during open: ${sessionId}`);
    }
    return registerLive(workspace.id, handle, runtime.queueFixtureTurn);
  })();

  openingSessions.set(key, openPromise);
  try {
    return await openPromise;
  } finally {
    // Clear on both success and failure so retries can re-open after a failed open.
    if (openingSessions.get(key) === openPromise) {
      openingSessions.delete(key);
    }
  }
}

/** Current genuine Pi tool update for an SSE snapshot; never reconstructed from a Run Record. */
export function getActiveAgentSessionTool(
  workspaceId: string,
  sessionId: string,
): AgentSseActiveTool | undefined {
  return liveSessions.get(sessionKey(workspaceId, sessionId))?.activeTool;
}

/** Public projections for live-only Sessions that Pi has not persisted yet. */
export function listLiveAgentSessionSummaries(workspaceId: string): LiveAgentSessionSummary[] {
  return [...liveSessions.values()]
    .filter((entry) => entry.workspaceId === workspaceId)
    .map(projectLiveSession);
}

/**
 * Abort any live turn, wait briefly for idle/settle, dispose the handle, then
 * cascade v2 Run data + SessionManager JSONL. Gate waiters are rejected first
 * so wiki_produce cannot keep writing after delete begins.
 *
 * Single-flight per key (like ensureRegistered open): concurrent deletes await
 * the same promise so the deleting barrier stays up until the cascade finishes.
 * Also serialized against cold open: marks deleting, awaits any in-flight open
 * (disposing a late-arriving handle via the deleting map), then tears down.
 */
export async function deleteAgentSession(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<{ sessionId: string; removed: number }> {
  const key = sessionKey(workspace.id, sessionId);

  const inFlightDelete = deletingSessions.get(key);
  if (inFlightDelete) return inFlightDelete;

  // Box so the finally ownership check can compare the same promise without TDZ.
  const flight: {
    promise?: Promise<{ sessionId: string; removed: number }>;
  } = {};
  flight.promise = (async (): Promise<{ sessionId: string; removed: number }> => {
    try {
      // Unblock gate waiters before filesystem cascade so tool catch can finish.
      pendingGates.get(key)?.reject(new Error("Wiki Run cancelled"));

      // Await the cold-open single-flight so we can dispose its handle. Without
      // this, openOperatorSession + registerLive can finish after disk delete and
      // reanimate a “deleted” session.
      const inFlightOpen = openingSessions.get(key);
      if (inFlightOpen) {
        try {
          await inFlightOpen;
        } catch {
          // Open failed or was cancelled by the deleting flag — nothing to dispose
          // from that path (handle disposed inside ensureRegistered if needed).
        }
      }

      const live = liveSessions.get(key);
      const hadLive = Boolean(live);

      if (live) {
        await live.handle.session.abort().catch(() => undefined);
        await waitForSessionQuiet(live, DELETE_SETTLE_TIMEOUT_MS);
        disposeLive(live);
        liveSessions.delete(key);
      }

      // Open's finally may already have cleared this; drop any stale entry.
      openingSessions.delete(key);

      const result = await deleteOperatorSession(workspace.rootPath, sessionId);
      return {
        sessionId,
        removed: (hadLive || result.deleted ? 1 : 0) + result.removedRunIds.length,
      };
    } finally {
      // Only the owning flight clears the barrier (single-flight, not refcount).
      if (deletingSessions.get(key) === flight.promise) {
        deletingSessions.delete(key);
      }
    }
  })();

  // Mark before any outer await so concurrent create/open/delete see the barrier.
  deletingSessions.set(key, flight.promise);
  return flight.promise;
}

/**
 * Wait until the AgentSession reports idle and the registry busy flag clears,
 * or until the timeout elapses. Fail-open: timeout resolves without error so
 * delete can still dispose and cascade disk (never hangs forever).
 */
async function waitForSessionQuiet(
  entry: RegisteredAgentSession,
  timeoutMs: number,
): Promise<void> {
  if (entry.handle.session.isIdle && !entry.busy) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        unsubscribe();
      } catch {
        // Listener already gone with dispose.
      }
      resolve();
    };

    const check = () => {
      if (entry.handle.session.isIdle && !entry.busy) finish();
    };

    const unsubscribe = entry.handle.session.subscribe((event) => {
      if (
        event.type === "agent_settled" ||
        event.type === "agent_end" ||
        event.type === "tool_execution_end"
      ) {
        check();
      }
    });
    const poll = setInterval(check, DELETE_SETTLE_POLL_MS);
    // Fail-open: proceed with delete even if the turn never reports idle.
    const timer = setTimeout(finish, timeoutMs);
    check();
  });
}

/** Read the active SessionManager branch, including a not-yet-flushed Session. */
export async function loadAgentSessionHistory(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<OperatorSessionHistory | null> {
  const live = liveSessions.get(sessionKey(workspace.id, sessionId));
  if (live) {
    const manager = live.handle.session.sessionManager;
    const messages = manager
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message as OperatorSessionHistory["messages"][number]);
    return {
      sessionId: manager.getSessionId(),
      // Operator snapshot only — do not mutate Pi-owned message objects.
      messages: redactSensitiveValue(messages),
    };
  }
  const history = await loadOperatorSessionHistory(workspace.rootPath, sessionId);
  if (!history) return null;
  return {
    sessionId: history.sessionId,
    messages: redactSensitiveValue(history.messages),
  };
}

/** Test helper: drop the live handle without cascading disk delete. */
export function evictLiveAgentSessionForTests(workspaceId: string, sessionId: string): void {
  const key = sessionKey(workspaceId, sessionId);
  const live = liveSessions.get(key);
  if (live) {
    disposeLive(live);
    liveSessions.delete(key);
  }
  openingSessions.delete(key);
  pendingGates.get(key)?.reject(new Error("test evict"));
}

/** Test helper. */
export function resetAgentSessionRegistryForTests(): void {
  for (const entry of liveSessions.values()) disposeLive(entry);
  liveSessions.clear();
  openingSessions.clear();
  deletingSessions.clear();
  for (const pending of pendingGates.values()) pending.reject(new Error("test reset"));
  pendingGates.clear();
}

function providerFailure(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const row = message as { role?: string; stopReason?: string; errorMessage?: string };
    if (row.role !== "assistant") continue;
    if (row.stopReason === "error" || row.stopReason === "aborted" || row.errorMessage?.trim()) {
      const raw = row.errorMessage?.trim() || `assistant stopReason=${row.stopReason ?? "error"}`;
      return redactErrorMessage(raw);
    }
    return null;
  }
  return null;
}

async function prompt(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
  text: string,
  canProduce: boolean,
): Promise<AgentCommandResponse> {
  if (entry.busy) {
    return {
      ok: false,
      sessionId: entry.handle.sessionId,
      command: "prompt",
      status: "failed",
      message: "Operator Session already has an active turn",
    };
  }
  entry.busy = true;
  try {
    if (entry.handle.session.sessionManager.getSessionName()?.trim() === defaultTitle(workspace)) {
      const title = titleFromPrompt(text);
      if (title) entry.handle.session.setSessionName(title);
    }
    entry.queueFixtureTurn?.(text, canProduce);
    await entry.handle.session.prompt(text);
    const failure = providerFailure(entry.handle.session.messages);
    return failure
      ? {
          ok: false,
          sessionId: entry.handle.sessionId,
          command: "prompt",
          status: "failed",
          message: `prompt failed: ${failure}`,
        }
      : {
          ok: true,
          sessionId: entry.handle.sessionId,
          command: "prompt",
          status: "accepted",
          message: "prompt completed",
        };
  } catch (error) {
    return {
      ok: false,
      sessionId: entry.handle.sessionId,
      command: "prompt",
      status: "failed",
      message: `prompt failed: ${redactErrorMessage(error)}`,
    };
  } finally {
    entry.busy = false;
  }
}

function resumeGate(
  workspace: WorkspaceConfig,
  sessionId: string,
  command: Extract<AgentCommand, { type: "resume_gate" }>,
): AgentCommandResponse {
  const pending = pendingGates.get(sessionKey(workspace.id, sessionId));
  if (!pending) {
    return {
      ok: false,
      sessionId,
      command: "resume_gate",
      status: "failed",
      message: "Operator Session has no pending Wiki Run gate",
      runId: command.runId,
    };
  }
  if (pending.request.gate !== command.gate) {
    return {
      ok: false,
      sessionId,
      command: "resume_gate",
      status: "failed",
      message: `pending gate is ${pending.request.gate}, not ${command.gate}`,
      runId: pending.request.runId,
    };
  }
  if (command.runId && command.runId !== pending.request.runId) {
    return {
      ok: false,
      sessionId,
      command: "resume_gate",
      status: "failed",
      message: "runId does not match the pending Wiki Run gate",
      runId: pending.request.runId,
    };
  }
  pending.resolve({
    action: command.action,
    feedback: command.feedback,
    spec: command.spec,
  });
  return {
    ok: true,
    sessionId,
    command: "resume_gate",
    status: "accepted",
    message: `${command.gate} gate ${command.action}`,
    runId: pending.request.runId,
  };
}

/** Delegate commands only to the real AgentSession or its active tool gate. */
export async function dispatchAgentCommand(
  workspace: WorkspaceConfig,
  sessionId: string,
  command: AgentCommand,
): Promise<AgentCommandResponse> {
  const entry = await ensureRegistered(workspace, sessionId);
  if (command.type === "resume_gate") return resumeGate(workspace, sessionId, command);

  if (command.type === "prompt") {
    return prompt(entry, workspace, command.text, workspace.sources.length > 0);
  }
  if (command.type === "steer") {
    try {
      await entry.handle.session.steer(command.text);
      return { ok: true, sessionId, command: "steer", status: "accepted" };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command: "steer",
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  }
  if (command.type === "abort") {
    await entry.handle.session.abort().catch(() => undefined);
    return { ok: true, sessionId, command: "abort", status: "accepted" };
  }
  await entry.handle.session.compact();
  return { ok: true, sessionId, command: "compact", status: "accepted" };
}
