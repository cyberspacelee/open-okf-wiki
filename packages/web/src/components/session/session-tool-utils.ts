/**
 * Pure helpers for Session tool parts (progress, agent detection, batching).
 */

import type { UIMessage } from "ai";

export function normalizeWikiPath(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Mastra / AI SDK sometimes nest the real payload under `result` / `output`.
 * Normalize so specialized bodies see the tool's own shape.
 */
/** Known tool names with specialized Session bodies (keep in sync with tool-bodies). */
export const REGISTERED_TOOL_BODY_NAMES = [
  "list_source",
  "list_skill",
  "list_wiki",
  "read_source",
  "read_skill",
  "read_wiki",
  "write_wiki",
  "glob_source",
  "search_source",
] as const;

export function unwrapToolPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (
    "result" in value &&
    value.result !== undefined &&
    (isRecord(value.result) ||
      Array.isArray(value.result) ||
      typeof value.result === "string")
  ) {
    const keys = Object.keys(value);
    if (
      keys.length <= 3 &&
      keys.some(
        (k) =>
          k === "result" ||
          k === "toolName" ||
          k === "toolCallId" ||
          k === "type",
      )
    ) {
      return unwrapToolPayload(value.result);
    }
  }
  if (
    "output" in value &&
    isRecord(value.output) &&
    Object.keys(value).length <= 3
  ) {
    return unwrapToolPayload(value.output);
  }
  return value;
}

export function toolNameFromPart(
  part: UIMessage["parts"][number],
): string | undefined {
  if (part.type === "dynamic-tool") {
    return "toolName" in part && typeof part.toolName === "string"
      ? part.toolName
      : "tool";
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    if ("toolName" in part && typeof part.toolName === "string" && part.toolName) {
      return part.toolName;
    }
    return part.type.slice(5);
  }
  return undefined;
}

export function isWriteWikiPart(part: UIMessage["parts"][number]): boolean {
  const name = toolNameFromPart(part);
  return name === "write_wiki";
}

export function pathFromWritePart(
  part: UIMessage["parts"][number],
): string | undefined {
  if (!isWriteWikiPart(part)) {
    return undefined;
  }
  const input = "input" in part ? part.input : undefined;
  if (input && typeof input === "object" && input !== null && "path" in input) {
    const path = String((input as { path?: unknown }).path ?? "").trim();
    if (path) {
      return normalizeWikiPath(path);
    }
  }
  const output = "output" in part ? part.output : undefined;
  if (
    output &&
    typeof output === "object" &&
    output !== null &&
    "path" in output
  ) {
    const path = String((output as { path?: unknown }).path ?? "").trim();
    if (path) {
      return normalizeWikiPath(path);
    }
  }
  return undefined;
}

/**
 * Collect written Spec pages from Produce `data-plan-progress` parts only.
 * Does not invent checklist status from tool-write_wiki (ADR 0029 / operator-event contract).
 */
export function writtenPathsFromMessages(
  messages: UIMessage | readonly UIMessage[],
): Set<string> {
  const list = Array.isArray(messages) ? messages : [messages];
  const paths = new Set<string>();
  for (const message of list) {
    for (const part of message.parts ?? []) {
      if (part.type === "data-plan-progress" && "data" in part) {
        const data = part.data;
        if (data && typeof data === "object" && Array.isArray((data as { pages?: unknown }).pages)) {
          for (const page of (data as { pages: Array<{ path?: string; status?: string }> }).pages) {
            if (page?.status === "written" && page.path) {
              paths.add(normalizeWikiPath(page.path));
            }
          }
        }
      }
    }
  }
  return paths;
}

/** Latest data-progress phase from messages (if any). */
export function latestPhaseFromMessages(
  messages: readonly UIMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    for (let j = (m.parts ?? []).length - 1; j >= 0; j--) {
      const p = m.parts![j]!;
      if (p.type === "data-progress" && "data" in p && p.data && typeof p.data === "object") {
        const phase = (p.data as { phase?: unknown }).phase;
        if (typeof phase === "string" && phase) {
          return phase;
        }
      }
    }
  }
  return undefined;
}

const RESEARCH_TOOLS = new Set([
  "list_source",
  "read_source",
  "glob_source",
  "search_source",
  "list_skill",
  "read_skill",
  "list_wiki",
  "read_wiki",
]);

/** Tools that are safe to batch when consecutive and completed. */
export function isBatchableToolName(toolName: string): boolean {
  return RESEARCH_TOOLS.has(toolName);
}

/**
 * Known subagent / agent-as-tool names used by Mastra Root.agents map
 * and common AI SDK / Mastra envelopes (agent-*, okf-wiki-*, tool-agent-*).
 */
const AGENT_NAME_RE =
  /^(agent[-_]|tool-agent[-_]|okf-wiki-)?(domainResearcher|leafResearcher|reviewer|domain_researcher|leaf_researcher|domain|leaf)(-\d+)?$/i;

export type AgentRoleKind = "domain" | "leaf" | "reviewer" | "agent";

export function isAgentToolName(toolName: string): boolean {
  const name = toolName.trim();
  if (!name) {
    return false;
  }
  if (AGENT_NAME_RE.test(name)) {
    return true;
  }
  if (/^agent[-_]/i.test(name) || /^tool-agent[-_]/i.test(name)) {
    return true;
  }
  // Mastra agent ids: okf-wiki-domain, okf-wiki-leaf, okf-wiki-reviewer-1
  if (/okf-wiki-(domain|leaf|reviewer)/i.test(name)) {
    return true;
  }
  if (/domainResearcher|leafResearcher/i.test(name)) {
    return true;
  }
  return false;
}

export function agentRoleKind(toolName: string): AgentRoleKind {
  const n = toolName.toLowerCase();
  if (/reviewer/.test(n)) {
    return "reviewer";
  }
  if (/leaf/.test(n)) {
    return "leaf";
  }
  if (/domain/.test(n)) {
    return "domain";
  }
  return "agent";
}

export function agentDisplayName(toolName: string): string {
  const bare = toolName
    .replace(/^(agent[-_]|tool-agent[-_]|okf-wiki-)/i, "")
    .replace(/-\d+$/, "");
  const kind = agentRoleKind(toolName);
  switch (kind) {
    case "domain":
      return "Domain Researcher";
    case "leaf":
      return "Leaf Researcher";
    case "reviewer":
      return "Wiki Reviewer";
    default: {
      const cleaned = bare || toolName;
      return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
    }
  }
}

export type RenderItem =
  | { kind: "single"; index: number; part: UIMessage["parts"][number] }
  | {
      kind: "batch";
      toolName: string;
      start: number;
      end: number;
      parts: UIMessage["parts"][number][];
    };

/**
 * Collapse consecutive completed batchable tools (same name) into groups of 2+.
 * Streaming / running tools stay unbatched so status stays visible.
 */
export function groupPartsForRender(
  parts: UIMessage["parts"],
): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    const name = toolNameFromPart(part);
    const state =
      "state" in part && typeof part.state === "string"
        ? part.state
        : "output-available";
    const completed = state === "output-available" || state === "output-error";

    if (
      name &&
      isBatchableToolName(name) &&
      completed &&
      !isAgentToolName(name)
    ) {
      let j = i + 1;
      while (j < parts.length) {
        const next = parts[j]!;
        const nextName = toolNameFromPart(next);
        const nextState =
          "state" in next && typeof next.state === "string"
            ? next.state
            : "output-available";
        const nextDone =
          nextState === "output-available" || nextState === "output-error";
        if (nextName === name && nextDone) {
          j += 1;
          continue;
        }
        break;
      }
      if (j - i >= 2) {
        items.push({
          kind: "batch",
          toolName: name,
          start: i,
          end: j - 1,
          parts: parts.slice(i, j),
        });
        i = j;
        continue;
      }
    }

    items.push({ kind: "single", index: i, part });
    i += 1;
  }
  return items;
}
