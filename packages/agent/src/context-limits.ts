/**
 * Resolve operational context budgets and Mastra input processors for Wiki Runs.
 *
 * - Model profile `maxContextTokens` is the provider hard window.
 * - Workspace `limits.contextTargetTokens` is the operational compaction target.
 * - When only the hard window is set, target = floor(max * CONTEXT_COMPACTION_RATIO).
 * - When neither is set, processors are omitted (no guessed window).
 *
 * Hard safety net: ToolCallFilter + TokenLimiter (this module).
 * Semantic compaction: Observational Memory on Root/Reviewer (see wiki-memory.ts).
 */

import {
  TokenLimiterProcessor,
  ToolCallFilter,
  type InputProcessor,
} from "@mastra/core/processors";
import type { WorkspaceConfig } from "@okf-wiki/contract";

/** Fraction of maxContextTokens used as the operational compaction target. */
export const CONTEXT_COMPACTION_RATIO = 0.85;

/**
 * Keep tool calls/results from this many recent tool-producing steps;
 * older tool payloads are stripped before TokenLimiter runs.
 */
export const CONTEXT_TOOL_RESULT_RECENT_STEPS = 2;

export type ResolveContextTargetInput = {
  /** Explicit workspace operational target (preferred). */
  contextTargetTokens?: number;
  /** Provider hard window from the selected model profile. */
  maxContextTokens?: number;
  /** Override ratio when deriving from maxContextTokens (default 0.85). */
  ratio?: number;
};

/**
 * Resolve the token budget applied by TokenLimiter during multi-step Wiki generation.
 * Returns undefined when no trustworthy budget is configured.
 */
export function resolveContextTargetTokens(
  input: ResolveContextTargetInput,
): number | undefined {
  const explicit = input.contextTargetTokens;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const max = input.maxContextTokens;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) {
    const ratio =
      typeof input.ratio === "number" &&
      Number.isFinite(input.ratio) &&
      input.ratio > 0 &&
      input.ratio <= 1
        ? input.ratio
        : CONTEXT_COMPACTION_RATIO;
    return Math.max(1, Math.floor(max * ratio));
  }
  return undefined;
}

/** Convenience: resolve from workspace limits + runtime profile max. */
export function resolveContextTargetForWorkspace(
  workspace: WorkspaceConfig,
  maxContextTokens?: number,
): number | undefined {
  return resolveContextTargetTokens({
    contextTargetTokens: workspace.limits?.contextTargetTokens,
    maxContextTokens,
  });
}

/**
 * Build Mastra input processors that keep multi-step Wiki agent history under budget:
 * 1. Strip old tool results (main bloat from read_source / list_source)
 * 2. Drop oldest non-system messages when still over the token target
 */
export function buildContextInputProcessors(
  targetTokens: number,
): InputProcessor[] {
  if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
    return [];
  }
  // Concrete processors satisfy InputProcessor; cast through the union so AgentConfig accepts the array.
  return [
    new ToolCallFilter({
      filterAfterToolSteps: CONTEXT_TOOL_RESULT_RECENT_STEPS,
      // Prefer compact model-facing tool output when tools publish it.
      preserveModelOutput: true,
    }),
    new TokenLimiterProcessor({
      limit: targetTokens,
      // Keep a continuous recent suffix so tool-call/result pairs stay valid.
      trimMode: "contiguous",
    }),
  ] as InputProcessor[];
}
