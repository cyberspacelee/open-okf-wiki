import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  OperatorSessionSchema,
  type OperatorSession,
  type SessionMessage,
  type PendingInteraction,
  type SessionWorkflowState,
} from "@okf-wiki/contract";
import { isPathInside, WORKSPACE_DIR_NAME } from "./workspace-store.js";

const SESSIONS_DIR = "sessions";

/** Serialize concurrent writes to the same session file (mid-stream checkpoints). */
const sessionWriteTail = new Map<string, Promise<unknown>>();

async function withSessionFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionWriteTail.get(filePath) ?? Promise.resolve();
  let release!: (v?: unknown) => void;
  const gate = new Promise((r) => {
    release = r;
  });
  sessionWriteTail.set(
    filePath,
    prev.then(() => gate).catch(() => gate),
  );
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (sessionWriteTail.get(filePath) === gate) {
      // only clear if we are still the tail (best-effort)
    }
  }
}

function sessionsDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME, SESSIONS_DIR);
}

function sessionPath(rootPath: string, sessionId: string): string {
  return path.join(sessionsDir(rootPath), `${sessionId}.json`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await withSessionFileLock(filePath, async () => {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    // Unique temp name avoids clobber races between concurrent writers.
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  });
}

export async function createOperatorSession(options: {
  workspaceRoot: string;
  workspaceId: string;
  title?: string;
}): Promise<OperatorSession> {
  const root = path.resolve(options.workspaceRoot);
  const dir = sessionsDir(root);
  if (!isPathInside(root, dir)) {
    throw new Error("sessions dir escapes workspace root");
  }
  const now = new Date().toISOString();
  const session = OperatorSessionSchema.parse({
    id: randomUUID(),
    workspaceId: options.workspaceId,
    title: options.title?.trim() || "Wiki Session",
    status: "active",
    messages: [],
    workflow: { phase: "idle" },
    pending: null,
    createdAt: now,
    updatedAt: now,
  });
  await atomicWriteJson(sessionPath(root, session.id), session);
  return session;
}

export async function loadOperatorSession(
  workspaceRoot: string,
  sessionId: string,
): Promise<OperatorSession | null> {
  if (!sessionId || sessionId.includes("..") || sessionId.includes("/") || sessionId.includes("\\")) {
    return null;
  }
  try {
    const raw = await readFile(sessionPath(workspaceRoot, sessionId), "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      // Corrupt mid-write (should be rare with file lock); treat as missing.
      return null;
    }
    const parsed = OperatorSessionSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveOperatorSession(
  workspaceRoot: string,
  session: OperatorSession,
): Promise<OperatorSession> {
  const root = path.resolve(workspaceRoot);
  const next = OperatorSessionSchema.parse({
    ...session,
    updatedAt: new Date().toISOString(),
  });
  const file = sessionPath(root, next.id);
  if (!isPathInside(root, file)) {
    throw new Error("session path escapes workspace root");
  }
  await atomicWriteJson(file, next);
  return next;
}

export async function listOperatorSessions(
  workspaceRoot: string,
): Promise<OperatorSession[]> {
  const dir = sessionsDir(workspaceRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const sessions: OperatorSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const id = name.slice(0, -".json".length);
    const s = await loadOperatorSession(workspaceRoot, id);
    if (s) {
      sessions.push(s);
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}

export async function appendSessionMessages(
  workspaceRoot: string,
  sessionId: string,
  messages: SessionMessage[],
  patch?: {
    status?: OperatorSession["status"];
    pending?: PendingInteraction | null;
    workflow?: Partial<SessionWorkflowState>;
  },
): Promise<OperatorSession> {
  const existing = await loadOperatorSession(workspaceRoot, sessionId);
  if (!existing) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const next: OperatorSession = {
    ...existing,
    messages: [...existing.messages, ...messages],
    status: patch?.status ?? existing.status,
    pending:
      patch && "pending" in patch ? (patch.pending ?? null) : existing.pending,
    workflow: patch?.workflow
      ? { ...existing.workflow, ...patch.workflow }
      : existing.workflow,
    updatedAt: new Date().toISOString(),
  };
  return saveOperatorSession(workspaceRoot, next);
}

export async function replaceSessionMessages(
  workspaceRoot: string,
  sessionId: string,
  messages: SessionMessage[],
  patch?: {
    status?: OperatorSession["status"];
    pending?: PendingInteraction | null;
    workflow?: Partial<SessionWorkflowState>;
  },
): Promise<OperatorSession> {
  const existing = await loadOperatorSession(workspaceRoot, sessionId);
  if (!existing) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const next: OperatorSession = {
    ...existing,
    messages,
    status: patch?.status ?? existing.status,
    pending:
      patch && "pending" in patch ? (patch.pending ?? null) : existing.pending,
    workflow: patch?.workflow
      ? { ...existing.workflow, ...patch.workflow }
      : existing.workflow,
    updatedAt: new Date().toISOString(),
  };
  return saveOperatorSession(workspaceRoot, next);
}

/**
 * Strip actionable HITL chips so history does not re-offer approve/deny after
 * cancel or operator reset.
 *
 * When `keepLatestAssistant` is true, chips on the newest assistant message
 * are preserved (current live gate). Older answered gates are always cleared.
 */
export function neutralizeSessionDecisionParts(
  messages: SessionMessage[],
  options?: { keepLatestAssistant?: boolean },
): SessionMessage[] {
  let keepIdx = -1;
  if (options?.keepLatestAssistant) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        keepIdx = i;
        break;
      }
    }
  }
  return messages.map((m, index) => {
    if (m.role !== "assistant") {
      return m;
    }
    if (index === keepIdx) {
      return m;
    }
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (
          typeof p.type === "string" &&
          p.type === "tool-request_user_decision" &&
          "state" in p &&
          p.state === "input-available"
        ) {
          return {
            ...p,
            state: "output-denied" as const,
            output: { cancelled: true },
          };
        }
        if (
          typeof p.type === "string" &&
          (p.type === "data-choice" || p.type === "data-gate")
        ) {
          const data =
            p && typeof p === "object" && "data" in p
              ? (p.data as Record<string, unknown>)
              : {};
          return {
            ...p,
            data: {
              ...data,
              cancelled: true,
              options: [],
              mode: "input_only",
            },
          };
        }
        return p;
      }),
    };
  });
}

/**
 * Clear pending gate so a new kickoff can start (keeps transcript + linked run id).
 */
export async function resetOperatorSessionWorkflow(
  workspaceRoot: string,
  sessionId: string,
): Promise<OperatorSession> {
  const existing = await loadOperatorSession(workspaceRoot, sessionId);
  if (!existing) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const messages = neutralizeSessionDecisionParts(existing.messages);
  return saveOperatorSession(workspaceRoot, {
    ...existing,
    messages,
    status: "active",
    pending: null,
    workflow: {
      ...existing.workflow,
      phase: "idle",
    },
  });
}

/** Delete a session file. Returns false when missing / invalid id. */
export async function deleteOperatorSession(
  workspaceRoot: string,
  sessionId: string,
): Promise<boolean> {
  if (
    !sessionId ||
    sessionId.includes("..") ||
    sessionId.includes("/") ||
    sessionId.includes("\\")
  ) {
    return false;
  }
  const root = path.resolve(workspaceRoot);
  const file = sessionPath(root, sessionId);
  if (!isPathInside(root, file)) {
    throw new Error("session path escapes workspace root");
  }
  try {
    await unlink(file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
