/**
 * Operator-visible Session projection for tool / data parts.
 *
 * Model tool loop keeps full fidelity inside Mastra. This module only shapes
 * what is streamed to the UI and persisted on OperatorSession (ADR 0026).
 *
 * Rules:
 * - read_*: keep path/sourceId; truncate content; mark truncated
 * - write_wiki: keep path; replace input.content with contentPreview + contentChars
 * - list_*: cap entries; mark truncated
 * - redact secrets in free-form strings
 */

import type { UIMessageChunk } from "ai";
import type { SessionMessage } from "@okf-wiki/contract";
import { sanitizeSummary, truncate } from "./stream-parts.js";

/** Max characters kept for read_* content in Session/UI. */
export const UI_READ_CONTENT_MAX = 4_096;
/** Max characters kept as write_wiki contentPreview. */
export const UI_WRITE_PREVIEW_MAX = 2_048;
/** Max list entries kept for list_* tools. */
export const UI_LIST_ENTRIES_MAX = 200;
/** Max JSON-ish string length for unknown tool payloads. */
export const UI_UNKNOWN_JSON_MAX = 1_600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactString(value: string): string {
  return (
    sanitizeSummary(value, Math.max(value.length, 1)) ??
    value
      .replace(/\bsk-[a-zA-Z0-9-]{10,}\b/g, "[redacted-key]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
  );
}

function truncateContent(
  content: string,
  max: number,
): { text: string; truncated: boolean; contentChars: number } {
  const contentChars = content.length;
  if (contentChars <= max) {
    return { text: content, truncated: false, contentChars };
  }
  return {
    text: truncate(content, max),
    truncated: true,
    contentChars,
  };
}

/**
 * Project write_wiki tool input: drop full markdown body from Session/UI.
 */
export function projectWriteWikiInput(input: unknown): unknown {
  if (!isRecord(input)) {
    return projectUnknownValue(input);
  }
  const path = typeof input.path === "string" ? input.path : undefined;
  const content = typeof input.content === "string" ? input.content : undefined;
  if (content === undefined) {
    return {
      ...input,
      ...(path ? { path } : {}),
    };
  }
  const { text, truncated, contentChars } = truncateContent(
    content,
    UI_WRITE_PREVIEW_MAX,
  );
  const next: Record<string, unknown> = {
    ...input,
    path: path ?? input.path,
    contentPreview: text,
    contentChars,
    truncated,
  };
  delete next.content;
  return next;
}

/**
 * Project read_* tool output: keep path metadata, truncate body.
 */
export function projectReadOutput(output: unknown): unknown {
  if (!isRecord(output)) {
    return projectUnknownValue(output);
  }
  const content = typeof output.content === "string" ? output.content : undefined;
  if (content === undefined) {
    return projectUnknownValue(output);
  }
  const { text, truncated, contentChars } = truncateContent(
    content,
    UI_READ_CONTENT_MAX,
  );
  return {
    ...output,
    content: text,
    contentChars,
    truncated,
  };
}

/**
 * Project list_* tool output: cap entries array.
 */
export function projectListOutput(output: unknown): unknown {
  if (!isRecord(output)) {
    return projectUnknownValue(output);
  }
  const entries = output.entries;
  if (!Array.isArray(entries)) {
    return projectUnknownValue(output);
  }
  if (entries.length <= UI_LIST_ENTRIES_MAX) {
    return output;
  }
  return {
    ...output,
    entries: entries.slice(0, UI_LIST_ENTRIES_MAX),
    entryCount: entries.length,
    truncated: true,
  };
}

export function projectUnknownValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactString(value);
    return redacted.length > UI_UNKNOWN_JSON_MAX
      ? truncate(redacted, UI_UNKNOWN_JSON_MAX)
      : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    const s = JSON.stringify(value);
    if (s.length <= UI_UNKNOWN_JSON_MAX) {
      return value;
    }
    // Prefer structured trim of common large keys over opaque string.
    if (isRecord(value)) {
      const next: Record<string, unknown> = { ...value, truncated: true };
      for (const key of ["content", "text", "body", "markdown", "data"]) {
        if (typeof next[key] === "string") {
          const t = truncateContent(String(next[key]), UI_READ_CONTENT_MAX);
          next[key] = t.text;
          next[`${key}Chars`] = t.contentChars;
        }
      }
      const again = JSON.stringify(next);
      if (again.length <= UI_UNKNOWN_JSON_MAX * 2) {
        return next;
      }
    }
    return { truncated: true, preview: truncate(redactString(s), UI_UNKNOWN_JSON_MAX) };
  } catch {
    return "[unserializable]";
  }
}

export function projectToolInput(toolName: string, input: unknown): unknown {
  const name = toolName.trim();
  if (name === "write_wiki") {
    return projectWriteWikiInput(input);
  }
  // CodeMode scripts can be long — keep a short preview only.
  if (name === "execute_typescript" || name === "code_mode") {
    if (!isRecord(input)) {
      return projectUnknownValue(input);
    }
    const next: Record<string, unknown> = { ...input };
    for (const key of ["code", "script", "source", "typescript"]) {
      if (typeof next[key] === "string") {
        const t = truncateContent(String(next[key]), UI_WRITE_PREVIEW_MAX);
        next[`${key}Preview`] = t.text;
        next[`${key}Chars`] = t.contentChars;
        next.truncated = t.truncated || next.truncated;
        delete next[key];
      }
    }
    return next;
  }
  // Other tools: inputs are path-sized; still redact free-form strings.
  if (!isRecord(input)) {
    return projectUnknownValue(input);
  }
  const next: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(next)) {
    if (typeof v === "string" && v.length > UI_WRITE_PREVIEW_MAX) {
      const t = truncateContent(v, UI_WRITE_PREVIEW_MAX);
      next[k] = t.text;
      next[`${k}Truncated`] = t.truncated;
    } else if (typeof v === "string") {
      next[k] = redactString(v);
    }
  }
  return next;
}

export function projectToolOutput(toolName: string, output: unknown): unknown {
  const name = toolName.trim();
  if (
    name === "read_source" ||
    name === "read_skill" ||
    name === "read_wiki"
  ) {
    return projectReadOutput(output);
  }
  if (
    name === "list_source" ||
    name === "list_skill" ||
    name === "list_wiki"
  ) {
    return projectListOutput(output);
  }
  // write_wiki output is already small {path, bytes}
  if (name === "write_wiki") {
    return isRecord(output) ? output : projectUnknownValue(output);
  }
  if (name === "execute_typescript" || name === "code_mode") {
    return projectUnknownValue(output);
  }
  return projectUnknownValue(output);
}

/**
 * Strip bulky workspace/input dumps from Mastra data-workflow* parts.
 * Operators only need name + status + short error — not full WorkspaceConfig.
 */
export function projectWorkflowDataPart(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }
  const status = typeof data.status === "string" ? data.status : undefined;
  const name = typeof data.name === "string" ? data.name : undefined;
  const runId = typeof data.runId === "string" ? data.runId : undefined;

  let error: string | undefined;
  if (data.error !== undefined) {
    try {
      // Local stringify path without importing run.ts (avoid cycles).
      if (typeof data.error === "string") {
        error = data.error.slice(0, 400);
      } else if (data.error instanceof Error) {
        error = data.error.message.slice(0, 400);
      } else if (isRecord(data.error) && typeof data.error.message === "string") {
        error = data.error.message.slice(0, 400);
      }
    } catch {
      error = "error";
    }
  }

  const stepsIn = isRecord(data.steps) ? data.steps : undefined;
  const stepsOut: Record<string, { name?: string; status?: string; error?: string }> =
    {};
  if (stepsIn) {
    for (const [id, step] of Object.entries(stepsIn)) {
      if (!isRecord(step)) {
        continue;
      }
      let stepErr: string | undefined;
      if (typeof step.error === "string") {
        stepErr = step.error.slice(0, 300);
      } else if (isRecord(step.error) && typeof step.error.message === "string") {
        stepErr = step.error.message.slice(0, 300);
      }
      stepsOut[id] = {
        name: typeof step.name === "string" ? step.name : id,
        status: typeof step.status === "string" ? step.status : undefined,
        ...(stepErr ? { error: stepErr } : {}),
      };
    }
  }

  // Nested step event shape: { step: { name, status }, status }
  let stepSummary: { name?: string; status?: string; error?: string } | undefined;
  if (isRecord(data.step)) {
    const st = data.step;
    stepSummary = {
      name: typeof st.name === "string" ? st.name : undefined,
      status: typeof st.status === "string" ? st.status : undefined,
    };
  }

  return {
    ...(name ? { name } : {}),
    ...(status ? { status } : {}),
    ...(runId ? { runId } : {}),
    ...(error ? { error } : {}),
    ...(Object.keys(stepsOut).length > 0 ? { steps: stepsOut } : {}),
    ...(stepSummary ? { step: stepSummary } : {}),
  };
}

/**
 * Project a live UIMessageChunk before Session stream write / durable acc.
 * Tool payloads and Mastra workflow data parts are operator-projected.
 */
export function projectUiMessageChunk(chunk: UIMessageChunk): UIMessageChunk {
  const v = chunk as UIMessageChunk & Record<string, unknown>;
  if (v.type === "tool-input-available") {
    const toolName = String(v.toolName ?? "tool");
    return {
      ...v,
      input: projectToolInput(toolName, v.input),
    } as UIMessageChunk;
  }
  if (v.type === "tool-output-available") {
    // toolName may be absent; resolve later from acc — try field if present.
    const toolName =
      typeof v.toolName === "string" && v.toolName
        ? v.toolName
        : typeof v.toolCallId === "string"
          ? "" // filled in apply path when name known
          : "";
    if (toolName) {
      return {
        ...v,
        output: projectToolOutput(toolName, v.output),
      } as UIMessageChunk;
    }
    // Defer name-specific projection: still bound unknown payloads.
    return {
      ...v,
      output: projectUnknownValue(v.output),
    } as UIMessageChunk;
  }
  if (v.type === "tool-input-delta" || v.type === "tool-input-start") {
    // Streaming input args can grow large for write_wiki; leave live deltas
    // alone (ephemeral) — final tool-input-available is projected.
    return chunk;
  }
  if (
    typeof v.type === "string" &&
    (v.type === "data-workflow" ||
      v.type === "data-workflow-step" ||
      v.type === "data-tool-workflow")
  ) {
    return {
      ...v,
      data: projectWorkflowDataPart(v.data),
    } as UIMessageChunk;
  }
  return chunk;
}

/**
 * Project a durable Session tool-like part (tool-* or dynamic-tool).
 */
export function projectSessionToolPart(
  part: SessionMessage["parts"][number],
): SessionMessage["parts"][number] {
  if (part.type === "dynamic-tool") {
    const tool = part as {
      type: "dynamic-tool";
      toolCallId?: string;
      toolName?: string;
      state?: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };
    const toolName = tool.toolName ?? "tool";
    return {
      ...tool,
      input:
        tool.input !== undefined
          ? projectToolInput(toolName, tool.input)
          : undefined,
      output:
        tool.output !== undefined
          ? projectToolOutput(toolName, tool.output)
          : undefined,
      errorText:
        typeof tool.errorText === "string"
          ? redactString(tool.errorText)
          : tool.errorText,
    } as SessionMessage["parts"][number];
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    const tool = part as {
      type: string;
      toolCallId?: string;
      toolName?: string;
      state?: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };
    const toolName =
      tool.toolName ??
      (tool.type.startsWith("tool-") ? tool.type.slice(5) : "tool");
    return {
      ...tool,
      toolName,
      input:
        tool.input !== undefined
          ? projectToolInput(toolName, tool.input)
          : undefined,
      output:
        tool.output !== undefined
          ? projectToolOutput(toolName, tool.output)
          : undefined,
      errorText:
        typeof tool.errorText === "string"
          ? redactString(tool.errorText)
          : tool.errorText,
    } as SessionMessage["parts"][number];
  }
  return part;
}

/** Project all tool parts in durable Session messages (load / finalize safety). */
export function projectSessionMessages(
  messages: SessionMessage[],
): SessionMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: (m.parts ?? []).map((p) => projectSessionToolPart(p)),
  }));
}

/**
 * Project tool-output-available using a known toolName (from prior input chunk).
 */
export function projectToolOutputChunk(
  chunk: UIMessageChunk,
  toolName: string,
): UIMessageChunk {
  const v = chunk as UIMessageChunk & Record<string, unknown>;
  if (v.type !== "tool-output-available") {
    return projectUiMessageChunk(chunk);
  }
  return {
    ...v,
    output: projectToolOutput(toolName, v.output),
  } as UIMessageChunk;
}

// --- Product progress data parts (operator timeline) ---

export type PlanPageStatus = "pending" | "written" | "skipped";

export type PlanProgressPage = {
  path: string;
  status: PlanPageStatus;
};

export type PlanProgressData = {
  runId?: string;
  pages: PlanProgressPage[];
  phase?: string;
};

export type PhaseProgressData = {
  phase: string;
  runId?: string;
  label?: string;
};

function normalizePath(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

/** Build plan page progress from planned pages + written paths. */
export function buildPlanProgressData(input: {
  planPages?: Array<{ path: string }>;
  writtenPaths: Iterable<string>;
  runId?: string;
  phase?: string;
}): PlanProgressData {
  const written = new Set(
    [...input.writtenPaths].map((p) => normalizePath(String(p))),
  );
  const pages: PlanProgressPage[] = (input.planPages ?? []).map((p) => {
    const path = normalizePath(p.path);
    return {
      path,
      status: written.has(path) ? ("written" as const) : ("pending" as const),
    };
  });
  // Include extra written paths not in the plan (operator visibility).
  for (const path of written) {
    if (!pages.some((p) => p.path === path)) {
      pages.push({ path, status: "written" });
    }
  }
  return {
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    pages,
  };
}

export function buildPhaseProgressData(input: {
  phase: string;
  runId?: string;
  label?: string;
}): PhaseProgressData {
  return {
    phase: input.phase,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
}

/** Extract write path from projected write_wiki tool input/output. */
export function writePathFromToolFields(
  input: unknown,
  output: unknown,
): string | undefined {
  if (isRecord(output) && typeof output.path === "string" && output.path) {
    return normalizePath(output.path);
  }
  if (isRecord(input) && typeof input.path === "string" && input.path) {
    return normalizePath(input.path);
  }
  return undefined;
}
