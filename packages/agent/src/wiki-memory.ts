/**
 * Mastra Observational Memory for Wiki Runs.
 *
 * When a context budget is configured, Root (and explicit Reviewer generate)
 * use official @mastra/memory OM so unobserved multi-step history is
 * summarized into an observation log instead of growing unbounded.
 *
 * TokenLimiter + ToolCallFilter remain the hard safety net on every agent
 * (including Domain/Leaf). OM is not attached to short research subagents —
 * thread-scoped OM requires a threadId on every call, and supervisor
 * delegation does not always supply one.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { AgentMemoryOption } from "@mastra/core/agent";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { mastraStorageDir } from "./mastra-instance.js";

/** Fraction of operational context target that triggers Observer. */
export const OM_OBSERVATION_RATIO = 0.4;
/** Fraction of operational context target that triggers Reflector. */
export const OM_REFLECTION_RATIO = 0.3;
/**
 * Cap OM triggers below the hard TokenLimiter budget so summary runs
 * before history is hard-trimmed (never above 70% of context target).
 */
export const OM_MAX_FRACTION_OF_TARGET = 0.7;
/** Preferred floor for observation threshold when the budget allows. */
export const OM_MIN_MESSAGE_TOKENS = 8_000;
/** Preferred floor for reflection threshold when the budget allows. */
export const OM_MIN_OBSERVATION_TOKENS = 4_000;

function memoryDbUrl(): string {
  if (process.env.OKF_WIKI_MASTRA_STORAGE === "memory") {
    return ":memory:";
  }
  const dir = mastraStorageDir();
  mkdirSync(dir, { recursive: true });
  return `file:${path.join(dir, "memory.db")}`;
}

/**
 * Clamp a preferred threshold under the hard context target so OM always
 * fires before TokenLimiter (when both are active).
 */
function clampUnderTarget(
  preferred: number,
  contextTargetTokens: number,
): number {
  const hardCap = Math.max(
    1,
    Math.floor(contextTargetTokens * OM_MAX_FRACTION_OF_TARGET),
  );
  // Prefer preferred, but never exceed hardCap; never go below 1.
  return Math.max(1, Math.min(preferred, hardCap));
}

/** Derive Observer trigger from the operational context target. */
export function resolveObservationMessageTokens(
  contextTargetTokens: number,
): number {
  if (!Number.isFinite(contextTargetTokens) || contextTargetTokens <= 0) {
    return OM_MIN_MESSAGE_TOKENS;
  }
  const preferred = Math.max(
    OM_MIN_MESSAGE_TOKENS,
    Math.floor(contextTargetTokens * OM_OBSERVATION_RATIO),
  );
  return clampUnderTarget(preferred, contextTargetTokens);
}

/** Derive Reflector trigger from the operational context target. */
export function resolveReflectionObservationTokens(
  contextTargetTokens: number,
): number {
  if (!Number.isFinite(contextTargetTokens) || contextTargetTokens <= 0) {
    return OM_MIN_OBSERVATION_TOKENS;
  }
  const preferred = Math.max(
    OM_MIN_OBSERVATION_TOKENS,
    Math.floor(contextTargetTokens * OM_REFLECTION_RATIO),
  );
  return clampUnderTarget(preferred, contextTargetTokens);
}

export type CreateWikiRunMemoryInput = {
  /** Same model as the Wiki agent (private gateways — never force google/*). */
  model: MastraModelConfig;
  /** Operational compaction budget (workspace target or max×0.85). */
  contextTargetTokens: number;
};

/**
 * Build a per-process Memory with Observational Memory enabled.
 * Call only when a trustworthy context target is available.
 */
export function createWikiRunMemory(input: CreateWikiRunMemoryInput): Memory {
  const messageTokens = resolveObservationMessageTokens(
    input.contextTargetTokens,
  );
  const observationTokens = resolveReflectionObservationTokens(
    input.contextTargetTokens,
  );

  return new Memory({
    storage: new LibSQLStore({
      id: "okf-wiki-agent-memory",
      url: memoryDbUrl(),
    }),
    options: {
      // Keep a modest raw tail until OM activates; OM then replaces bulk history.
      lastMessages: 40,
      observationalMemory: {
        model: input.model,
        scope: "thread",
        observation: {
          messageTokens,
          // Buffer during multi-step tool loops; activate near messageTokens.
          bufferTokens: 0.25,
          instruction:
            "This is a Wiki Run investigation. Prefer durable facts: source paths, " +
            "page plan, evidence gaps, receipt references, and open questions. " +
            "Drop raw file dumps and long tool payloads; keep concise path-backed findings.",
        },
        reflection: {
          observationTokens,
          instruction:
            "Condense Wiki Run observations into a short control state: objective, " +
            "intended pages, completed scopes, receipt refs, and remaining gaps.",
        },
      },
    },
  });
}

/**
 * Thread/resource for one Wiki Run agent role.
 * Resource is run-scoped so Manual Retry does not inherit prior history.
 */
export function wikiRunMemoryOption(
  runId: string,
  role: "root" | "reviewer" | string,
): AgentMemoryOption {
  return {
    thread: `wiki-run-${runId}-${role}`,
    resource: `wiki-run-${runId}`,
  };
}
