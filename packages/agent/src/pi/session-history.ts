/**
 * Cold-read Pi session history for Operator UI reload (pi-web pattern).
 * Uses SessionManager only — does not create a live AgentSession.
 *
 * Aligns with pi-ai content blocks: text, thinking, toolCall.
 * Failed assistant turns (stopReason error) are kept so the UI can show them.
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { piSessionsDir } from "./session-paths.js";

export type ProjectedHistoryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  status?: "done" | "error";
  errorMessage?: string;
  createdAt?: string;
  tools?: Array<{
    id: string;
    name: string;
    status: "running" | "done" | "error";
  }>;
};

export type PiSessionHistory = {
  sessionId: string;
  sessionFile?: string;
  messages: ProjectedHistoryMessage[];
  leafId?: string | null;
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("");
}

function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; thinking?: string };
    if (b.type === "thinking" && typeof b.thinking === "string") {
      parts.push(b.thinking);
    }
  }
  return parts.join("");
}

function toolsFromContent(
  content: unknown,
): ProjectedHistoryMessage["tools"] {
  if (!Array.isArray(content)) return undefined;
  const tools: NonNullable<ProjectedHistoryMessage["tools"]> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as {
      type?: string;
      id?: string;
      name?: string;
      toolCallId?: string;
      toolName?: string;
    };
    if (b.type === "toolCall" || b.type === "tool_use") {
      tools.push({
        id: b.id ?? b.toolCallId ?? `tool_${tools.length}`,
        name: b.name ?? b.toolName ?? "tool",
        status: "done",
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}

function projectPiMessages(
  messages: unknown[],
  entryIds?: string[],
): ProjectedHistoryMessage[] {
  const out: ProjectedHistoryMessage[] = [];
  messages.forEach((msg, i) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      stopReason?: string;
      errorMessage?: string;
      timestamp?: number;
    };
    const role = m.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      return;
    }
    // Skip toolResult rows (pi-web nests tools under assistant).
    if (role === "user" && m.toolCallId) {
      return;
    }
    const text = textFromContent(m.content);
    const thinking = thinkingFromContent(m.content);
    const tools = role === "assistant" ? toolsFromContent(m.content) : undefined;
    const stopReason = typeof m.stopReason === "string" ? m.stopReason : undefined;
    const errorMessage =
      typeof m.errorMessage === "string" && m.errorMessage.trim()
        ? m.errorMessage.trim()
        : undefined;
    const isError =
      role === "assistant" &&
      (stopReason === "error" ||
        stopReason === "aborted" ||
        Boolean(errorMessage));
    // Keep error / thinking-only / tool-only turns — never drop silent failures.
    if (!text.trim() && !tools?.length && !thinking.trim() && !isError) {
      return;
    }
    const displayText =
      text.trim() ||
      (isError && errorMessage ? errorMessage : "") ||
      "";
    out.push({
      id: entryIds?.[i] ?? `hist_${i}`,
      role,
      text: displayText,
      thinking: thinking.trim() || undefined,
      status: isError ? "error" : "done",
      errorMessage: isError ? errorMessage : undefined,
      createdAt:
        typeof m.timestamp === "number"
          ? new Date(m.timestamp).toISOString()
          : undefined,
      tools,
    });
  });
  return out;
}

/**
 * Resolve a session file path under pi-sessions for a session id.
 */
export async function findPiSessionFile(
  workspaceRoot: string,
  sessionId: string,
): Promise<string | null> {
  const dir = piSessionsDir(workspaceRoot);
  const safe = sessionId.replace(/[/\\]/g, "_");
  const candidates = [
    path.join(dir, `${safe}.jsonl`),
    path.join(dir, safe, "session.jsonl"),
    path.join(dir, safe),
  ];
  for (const p of candidates) {
    try {
      const st = await stat(p);
      if (st.isFile()) return p;
      if (st.isDirectory()) {
        // Prefer *.jsonl inside dir
        const names = await readdir(p);
        const jsonl = names.find((n) => n.endsWith(".jsonl"));
        if (jsonl) return path.join(p, jsonl);
      }
    } catch {
      // continue
    }
  }

  // Fall back to SessionManager.list under the sessions dir
  try {
    const listed = await SessionManager.list(dir);
    const hit = listed.find(
      (s) => s.id === sessionId || s.id === safe || s.path.includes(safe),
    );
    if (hit?.path) return hit.path;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Load conversation snapshot for UI without creating AgentSession.
 */
export async function loadPiSessionHistory(
  workspaceRoot: string,
  sessionId: string,
): Promise<PiSessionHistory> {
  const sessionFile = await findPiSessionFile(workspaceRoot, sessionId);
  if (!sessionFile) {
    return { sessionId, messages: [] };
  }

  try {
    const sm = SessionManager.open(sessionFile);
    const ctx = sm.buildSessionContext() as {
      messages?: unknown[];
      entryIds?: string[];
    };
    const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
    return {
      sessionId,
      sessionFile,
      messages: projectPiMessages(messages, ctx.entryIds),
      leafId: sm.getLeafId?.() ?? null,
    };
  } catch {
    return { sessionId, sessionFile, messages: [] };
  }
}
