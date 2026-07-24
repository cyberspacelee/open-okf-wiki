/**
 * Cold-read Pi session history for Operator UI reload (pi-web pattern).
 * Uses SessionManager only — does not create a live AgentSession.
 *
 * Returns:
 * - Pi-shaped messages with content blocks intact (text / thinking /
 *   toolCall / toolResult). No product-side flattened UI message model.
 * - `produceUnits`: last-by-unitId fold of parent-visible
 *   `okf.produce_progress` custom entries (mid-run throttle + settle;
 *   not LLM context). Live authority is parent `wiki_produce` tool_execution_*.
 *
 * Pi file naming (SessionManager.newSession):
 *   `{ISO-timestamp}_{sessionId}.jsonl` under the session dir
 * Not `{sessionId}.jsonl`. findPiSessionFile must match that pattern.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  OKF_PRODUCE_PROGRESS_CUSTOM_TYPE,
  type ProduceToolDetails,
} from "../produce/tools/wiki-produce-progress.js";
import { piSessionsDir } from "./session-paths.js";

/** Agent-local content blocks aligned with pi-ai (not re-exported into contract). */
export type PiTextContent = { type: "text"; text: string };
export type PiThinkingContent = {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
};
export type PiImageContent = { type: "image"; data: string; mimeType: string };
export type PiToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type PiUserMessage = {
  role: "user";
  content: string | (PiTextContent | PiImageContent)[];
  timestamp?: number;
};

export type PiAssistantMessage = {
  role: "assistant";
  content: (PiTextContent | PiThinkingContent | PiToolCallContent)[];
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
};

export type PiToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (PiTextContent | PiImageContent)[];
  isError?: boolean;
  timestamp?: number;
};

/** Session history message — Pi roles with content blocks intact. */
export type PiHistoryMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export type PiSessionHistory = {
  sessionId: string;
  sessionFile?: string;
  messages: PiHistoryMessage[];
  leafId?: string | null;
  /**
   * Parent-visible produce units from durable `okf.produce_progress` custom
   * entries on the active branch (last-by-unitId). Not workUnits / not product inject.
   */
  produceUnits?: ProduceToolDetails[];
};

/**
 * Fold ProduceToolDetails patches last-by-unitId (stable unit key).
 * Used for cold custom entries and live SSE patches.
 */
export function foldProduceUnitDetails(
  prev: readonly ProduceToolDetails[],
  next: ProduceToolDetails,
): ProduceToolDetails[] {
  const unitId = (next.unitId?.trim() || next.role || "unit").slice(0, 120);
  const patched: ProduceToolDetails = { ...next, unitId };
  const idx = prev.findIndex((u) => (u.unitId?.trim() || u.role) === unitId);
  if (idx < 0) return [...prev, patched];
  const out = prev.slice();
  out[idx] = { ...out[idx], ...patched, unitId };
  return out;
}

/**
 * Extract last-by-unitId produce units from SessionManager branch entries.
 * Only `type:"custom"` + `customType:"okf.produce_progress"`.
 */
export function produceUnitsFromSessionEntries(
  entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
): ProduceToolDetails[] {
  let units: ProduceToolDetails[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType !== OKF_PRODUCE_PROGRESS_CUSTOM_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as ProduceToolDetails;
    if (typeof data.role !== "string" || typeof data.status !== "string") continue;
    units = foldProduceUnitDetails(units, data);
  }
  return units;
}

/**
 * Whether a filename is Pi's durable session JSONL for `sessionId`.
 * Matches `{timestamp}_{sessionId}.jsonl` and plain `{sessionId}.jsonl`.
 */
export function isPiSessionJsonlName(fileName: string, sessionId: string): boolean {
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
          (s.path.includes(`_${safe}.jsonl`) || s.path.endsWith(`${safe}.jsonl`))),
    );
    if (hit?.path) return hit.path;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Load conversation snapshot for UI without creating AgentSession.
 * Messages keep Pi content blocks; no text/thinking/tools flattening.
 * Also loads parent-visible produce units from okf.produce_progress custom entries
 * (buildSessionContext omits custom entries — they are not LLM context).
 */
export async function loadPiSessionHistory(
  workspaceRoot: string,
  sessionId: string,
  options?: { preferredPath?: string | null },
): Promise<PiSessionHistory> {
  const sessionFile = await findPiSessionFile(workspaceRoot, sessionId, options);
  if (!sessionFile) {
    return { sessionId, messages: [], produceUnits: [] };
  }

  try {
    const sm = SessionManager.open(sessionFile);
    const ctx = sm.buildSessionContext();
    const raw = Array.isArray(ctx.messages) ? ctx.messages : [];
    // Structural cast: SessionManager yields pi-agent-core AgentMessage[];
    // cold-load consumers only need role + content blocks.
    const messages = raw as PiHistoryMessage[];
    // Active branch includes custom entries that buildSessionContext drops.
    const branch = sm.getBranch();
    const produceUnits = produceUnitsFromSessionEntries(branch);
    return {
      sessionId,
      sessionFile,
      messages,
      leafId: sm.getLeafId() ?? null,
      produceUnits,
    };
  } catch {
    return { sessionId, sessionFile, messages: [], produceUnits: [] };
  }
}
