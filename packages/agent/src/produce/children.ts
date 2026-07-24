/**
 * In-process Pi child sessions for Domain / Leaf / Reviewer / Plan (ADR 0030).
 * Prefer SDK embedding over spawning the `pi` CLI.
 *
 * Provider failures often complete session.prompt() without throwing
 * (stopReason "error"). We fail closed instead of inventing empty success.
 *
 * Child events stay inside the child Session implementation. The parent
 * Operator Session exposes only the real `wiki_produce` tool lifecycle.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveAssistantSummary } from "../pi/assistant-outcome.js";
import { createWikiSession, type WikiSessionHandle } from "../pi/create-wiki-session.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import type { WikiAgentRole } from "../pi/tool-policy.js";

export type ChildRole = Extract<
  WikiAgentRole,
  "domain" | "leaf" | "reviewer" | "root_research" | "plan"
>;

export type RunChildSessionInput = {
  role: ChildRole;
  runWorkDir: string;
  task: string;
  systemPrompt?: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  /** When true, skip LLM and return a fixture summary. */
  fixture?: boolean;
  abortSignal?: AbortSignal;
  /** Soft timeout in ms (host abort via session.abort). */
  timeoutMs?: number;
};

export type RunChildSessionResult = {
  role: ChildRole;
  summary: string;
  mode: "fixture" | "live";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Run a read-only child agent for research/review/plan.
 * Always uses role allowlist (no write, no bash).
 */
export async function runChildSession(input: RunChildSessionInput): Promise<RunChildSessionResult> {
  if (input.abortSignal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }

  // Explicit fixture only (arg or OKF_WIKI_AGENT_MODE=fixture). No auto-fallback.
  if (input.fixture === true || process.env.OKF_WIKI_AGENT_MODE === "fixture") {
    return {
      role: input.role,
      mode: "fixture",
      summary: `[fixture ${input.role}] ${input.task.slice(0, 200)}`,
    };
  }

  if (!input.model) {
    throw new Error(
      `Child session (${input.role}) live mode requires a model, or pass fixture: true / OKF_WIKI_AGENT_MODE=fixture for smoke only`,
    );
  }

  let handle: WikiSessionHandle | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try {
      handle?.session.abort();
    } catch {
      // best-effort
    }
  };

  try {
    handle = await createWikiSession({
      role: input.role,
      runWorkDir: input.runWorkDir,
      model: input.model,
      modelRuntime: input.modelRuntime,
      systemPrompt:
        input.systemPrompt ??
        `You are a ${input.role} researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.`,
      sourceIgnores: input.sourceIgnores,
      maxContextTokens: input.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      scopedTools: true,
    });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        onAbort();
        const err = new Error("Wiki Run cancelled");
        err.name = "AbortError";
        throw err;
      }
      input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutId = setTimeout(onAbort, input.timeoutMs);
    }

    let text = "";
    const unsub = handle.session.subscribe((event) => {
      const kind =
        event && typeof event === "object" && "type" in event
          ? String((event as { type: unknown }).type)
          : "event";
      if (kind !== "message_update") return;
      // Narrow via unknown — Pi event unions omit assistantMessageEvent on some arms.
      const raw = event as unknown;
      if (!isRecord(raw)) return;
      const ame = isRecord(raw.assistantMessageEvent) ? raw.assistantMessageEvent : null;
      if (!ame) return;
      if (ame.type === "text_delta" && typeof ame.delta === "string") {
        text += ame.delta;
      }
    });

    try {
      await handle.session.prompt(input.task);
    } finally {
      unsub();
    }

    if (input.abortSignal?.aborted) {
      const err = new Error("Wiki Run cancelled");
      err.name = "AbortError";
      throw err;
    }

    const resolved = resolveAssistantSummary({
      streamedText: text,
      messages: handle.session.messages,
      roleLabel: input.role,
    });
    if (resolved.isError) {
      throw new Error(
        `Child session (${input.role}) failed: ${resolved.errorMessage ?? resolved.summary}`,
      );
    }

    return {
      role: input.role,
      mode: "live",
      summary: resolved.summary,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (input.abortSignal) {
      input.abortSignal.removeEventListener("abort", onAbort);
    }
    handle?.dispose();
  }
}

/**
 * Fan-out helper with concurrency cap (product delegation limits).
 */
export async function runChildrenParallel(
  tasks: RunChildSessionInput[],
  opts?: { concurrency?: number },
): Promise<RunChildSessionResult[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? 2);
  const results: RunChildSessionResult[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await runChildSession(tasks[i]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
