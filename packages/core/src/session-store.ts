import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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

function sessionsDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME, SESSIONS_DIR);
}

function sessionPath(rootPath: string, sessionId: string): string {
  return path.join(sessionsDir(rootPath), `${sessionId}.json`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
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
    const parsed = OperatorSessionSchema.safeParse(JSON.parse(raw) as unknown);
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
