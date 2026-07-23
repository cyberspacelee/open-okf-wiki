/**
 * Cold-read Pi session history for Operator UI reload (pi-web pattern).
 * Uses SessionManager only — does not create a live AgentSession.
 *
 * Aligns with pi-ai content blocks: text, thinking, toolCall.
 * Failed assistant turns (stopReason error) are kept so the UI can show them.
 *
 * Pi file naming (SessionManager.newSession):
 *   `{ISO-timestamp}_{sessionId}.jsonl` under the session dir
 * Not `{sessionId}.jsonl`. findPiSessionFile must match that pattern.
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { piSessionsDir } from "./session-paths.js";

export type ProjectedHistoryTool = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  /** Compact JSON args for UI summary (OpenCode-style header). */
  input?: string;
  /** Plain-text result when available from paired toolResult. */
  output?: string;
};

export type ProjectedHistoryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  status?: "done" | "error";
  errorMessage?: string;
  createdAt?: string;
  tools?: ProjectedHistoryTool[];
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

function compactArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") {
    const t = args.trim();
    return t || undefined;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

/** Pull plain text from a Pi toolResult content array / envelope. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string };
      if (typeof b.text === "string" && b.text) parts.push(b.text);
    }
    if (parts.length) return parts.join("\n");
  }
  if (content && typeof content === "object") {
    const c = content as { content?: unknown; text?: string };
    if (typeof c.text === "string" && c.text.trim()) return c.text.trim();
    if (c.content !== undefined) return toolResultText(c.content);
  }
  return undefined;
}

function toolsFromContent(
  content: unknown,
  resultByCallId?: Map<string, { text?: string; isError?: boolean }>,
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
      arguments?: unknown;
      input?: unknown;
      args?: unknown;
    };
    if (b.type === "toolCall" || b.type === "tool_use") {
      const id = b.id ?? b.toolCallId ?? `tool_${tools.length}`;
      const paired = resultByCallId?.get(id);
      const input = compactArgs(b.arguments ?? b.input ?? b.args);
      tools.push({
        id,
        name: b.name ?? b.toolName ?? "tool",
        status: paired?.isError ? "error" : "done",
        input,
        output: paired?.text,
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Index toolResult rows so assistant toolCall blocks can show args + result
 * on cold load (pi-web nests tools under the assistant turn).
 */
function indexToolResults(
  messages: unknown[],
): Map<string, { text?: string; isError?: boolean }> {
  const map = new Map<string, { text?: string; isError?: boolean }>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as {
      role?: string;
      toolCallId?: string;
      tool_call_id?: string;
      content?: unknown;
      isError?: boolean;
      is_error?: boolean;
    };
    const role = m.role;
    const isToolResult =
      role === "toolResult" ||
      role === "tool" ||
      (role === "user" && Boolean(m.toolCallId || m.tool_call_id));
    if (!isToolResult) continue;
    const id = m.toolCallId ?? m.tool_call_id;
    if (!id || typeof id !== "string") continue;
    map.set(id, {
      text: toolResultText(m.content),
      isError: m.isError === true || m.is_error === true,
    });
  }
  return map;
}

/** Pure projection of Pi LLM messages → UI history rows (exported for tests). */
export function projectPiMessages(
  messages: unknown[],
  entryIds?: string[],
): ProjectedHistoryMessage[] {
  const resultByCallId = indexToolResults(messages);
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
    // Pi toolResult uses role "toolResult"; some paths use user+toolCallId.
    if (role === "user" && m.toolCallId) {
      return;
    }
    const text = textFromContent(m.content);
    const thinking = thinkingFromContent(m.content);
    const tools =
      role === "assistant"
        ? toolsFromContent(m.content, resultByCallId)
        : undefined;
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
 * Whether a filename is Pi's durable session JSONL for `sessionId`.
 * Matches `{timestamp}_{sessionId}.jsonl` and plain `{sessionId}.jsonl`.
 */
export function isPiSessionJsonlName(
  fileName: string,
  sessionId: string,
): boolean {
  if (!fileName.endsWith(".jsonl")) return false;
  if (fileName === `${sessionId}.jsonl`) return true;
  // Pi SessionManager: `${fileTimestamp}_${sessionId}.jsonl`
  return fileName.endsWith(`_${sessionId}.jsonl`);
}

/**
 * Resolve a session file path under pi-sessions for a session id.
 * Prefer an explicit path from product meta when known.
 */
export async function findPiSessionFile(
  workspaceRoot: string,
  sessionId: string,
  options?: { preferredPath?: string | null },
): Promise<string | null> {
  const preferred = options?.preferredPath?.trim();
  if (preferred) {
    try {
      const st = await stat(preferred);
      if (st.isFile()) return preferred;
    } catch {
      // fall through to discovery
    }
  }

  const dir = piSessionsDir(workspaceRoot);
  const safe = sessionId.replace(/[/\\]/g, "_");

  // 1) Exact / nested legacy candidates
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
        const names = await readdir(p);
        const jsonl = names.find((n) => isPiSessionJsonlName(n, safe));
        if (jsonl) return path.join(p, jsonl);
      }
    } catch {
      // continue
    }
  }

  // 2) Pi default naming: scan session dir for *_{sessionId}.jsonl
  //    Prefer the most recently modified match (resume latest fork/retry).
  try {
    const names = await readdir(dir);
    const matches: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!isPiSessionJsonlName(name, safe)) continue;
      const full = path.join(dir, name);
      try {
        const st = await stat(full);
        if (st.isFile()) {
          matches.push({ path: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // skip
      }
    }
    if (matches.length > 0) {
      matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return matches[0]!.path;
    }
  } catch {
    // dir missing
  }

  // 3) SessionManager.list(cwd, sessionDir) — note both args (pi-web / Pi SDK).
  //    A single-arg call treats the path as cwd and looks under ~/.pi/… — empty.
  try {
    const listed = await SessionManager.list(workspaceRoot, dir);
    const hit = listed.find(
      (s) =>
        s.id === sessionId ||
        s.id === safe ||
        (typeof s.path === "string" &&
          (s.path.includes(`_${safe}.jsonl`) ||
            s.path.endsWith(`${safe}.jsonl`))),
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
  options?: { preferredPath?: string | null },
): Promise<PiSessionHistory> {
  const sessionFile = await findPiSessionFile(
    workspaceRoot,
    sessionId,
    options,
  );
  if (!sessionFile) {
    return { sessionId, messages: [] };
  }

  try {
    const sm = SessionManager.open(sessionFile);
    const ctx = sm.buildSessionContext() as {
      messages?: unknown[];
    };
    const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
    return {
      sessionId,
      sessionFile,
      messages: projectPiMessages(messages),
      leafId: sm.getLeafId?.() ?? null,
    };
  } catch {
    return { sessionId, sessionFile, messages: [] };
  }
}
