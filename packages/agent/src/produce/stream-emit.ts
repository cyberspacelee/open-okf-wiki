/**
 * Produce stream data-* emission helpers (ADR 0026 / 0027 / 0029).
 */

import type { MergedDefectReport, WikiRunPlan } from "@okf-wiki/contract";
import { buildPlanProgressData } from "../ui-projection.js";
import {
  type StreamCustomWriter,
  type WikiRunStreamWriter,
  normalizeWikiPath,
} from "./types.js";

export function hasStreamCustom(
  writer: WikiRunStreamWriter,
): writer is StreamCustomWriter {
  return typeof (writer as { custom?: unknown }).custom === "function";
}

/**
 * Emit a data-* UI part via writer.custom when available (framework path).
 * Falls back to write() only for non-ToolStream test doubles.
 */
export async function writeCustomDataPart(
  writer: WikiRunStreamWriter | undefined,
  part: { type: `data-${string}`; data: unknown; id?: string },
): Promise<void> {
  if (!writer) {
    return;
  }
  if (hasStreamCustom(writer)) {
    await writer.custom(part);
    return;
  }
  await writer.write(part);
}

/** Emit plan page checklist from step writer (source of truth for Session UI). */
export async function emitPlanProgressFromWriter(
  writer: WikiRunStreamWriter | undefined,
  input: {
    plan?: WikiRunPlan;
    writtenPaths: Iterable<string>;
    runId: string;
    phase?: string;
  },
): Promise<void> {
  if (!writer) {
    return;
  }
  const data = buildPlanProgressData({
    planPages: input.plan?.pages,
    writtenPaths: input.writtenPaths,
    runId: input.runId,
    phase: input.phase ?? "writing",
  });
  if (data.pages.length === 0) {
    return;
  }
  await writeCustomDataPart(writer, {
    type: "data-plan-progress",
    data,
  });
}

/** Emit review council summary to Session timeline. */
export async function emitDefectsFromWriter(
  writer: WikiRunStreamWriter | undefined,
  input: {
    runId: string;
    round: number;
    merged: MergedDefectReport;
  },
): Promise<void> {
  await writeCustomDataPart(writer, {
    type: "data-defects",
    data: {
      runId: input.runId,
      round: input.round,
      clean: input.merged.clean,
      defectCount: input.merged.defects.length,
      blockingCount: input.merged.defects.filter(
        (d) => d.severity === "blocking",
      ).length,
      majorCount: input.merged.defects.filter((d) => d.severity === "major")
        .length,
      reviewerIds: input.merged.reviewerIds,
      summary: input.merged.summary,
      defects: input.merged.defects.slice(0, 12).map((d) => ({
        severity: d.severity,
        code: d.code,
        path: d.path,
        issue: d.issue.slice(0, 280),
      })),
    },
    id: `defects-${input.runId}-r${input.round}`,
  });
}

/** Best-effort tool name from a Mastra agent fullStream chunk. */
export function toolNameFromAgentChunk(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }
  const c = chunk as {
    type?: string;
    payload?: { toolName?: string; name?: string };
  };
  const type = c.type ?? "";
  if (
    !type.includes("tool") &&
    type !== "tool-call" &&
    type !== "tool-result" &&
    type !== "tool-call-result"
  ) {
    return undefined;
  }
  const name = c.payload?.toolName ?? c.payload?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * Extract write_wiki path from a Mastra agent fullStream chunk (tool-result /
 * tool-call with path). Returns undefined when not a write completion.
 */
export function writePathFromAgentChunk(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }
  const c = chunk as {
    type?: string;
    payload?: {
      toolName?: string;
      args?: unknown;
      result?: unknown;
      output?: unknown;
    };
  };
  const type = c.type ?? "";
  if (
    type !== "tool-result" &&
    type !== "tool-call-result" &&
    type !== "tool-output"
  ) {
    return undefined;
  }
  const payload = c.payload;
  if (!payload) {
    return undefined;
  }
  const toolName = payload.toolName;
  if (toolName && toolName !== "write_wiki") {
    return undefined;
  }
  // When toolName is omitted, still accept path-shaped results (fixture).
  const result = payload.result ?? payload.output;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const pathValue = (result as { path?: unknown }).path;
    if (typeof pathValue === "string" && pathValue) {
      return normalizeWikiPath(pathValue);
    }
  }
  if (payload.args && typeof payload.args === "object") {
    const pathValue = (payload.args as { path?: unknown }).path;
    if (typeof pathValue === "string" && pathValue) {
      return normalizeWikiPath(pathValue);
    }
  }
  return undefined;
}
