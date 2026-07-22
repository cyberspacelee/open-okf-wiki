/**
 * In-process Pi child sessions for Domain / Leaf / Reviewer (ADR 0030).
 * Prefer SDK embedding over spawning the `pi` CLI.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createWikiSession,
  type WikiSessionHandle,
} from "../pi/create-wiki-session.js";
import type { WikiAgentRole } from "../pi/tool-policy.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";

export type ChildRole = Extract<
  WikiAgentRole,
  "domain" | "leaf" | "reviewer" | "root_research"
>;

export type RunChildSessionInput = {
  role: ChildRole;
  runWorkDir: string;
  task: string;
  systemPrompt?: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  workspaceRoot?: string;
  sourceIgnores?: SourceIgnoreInput;
  /** When true, skip LLM and return a fixture summary. */
  fixture?: boolean;
  abortSignal?: AbortSignal;
};

export type RunChildSessionResult = {
  role: ChildRole;
  summary: string;
  mode: "fixture" | "live";
};

/**
 * Run a read-only child agent for research/review.
 * Always uses role allowlist (no write, no bash).
 */
export async function runChildSession(
  input: RunChildSessionInput,
): Promise<RunChildSessionResult> {
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
  try {
    handle = await createWikiSession({
      role: input.role,
      runWorkDir: input.runWorkDir,
      workspaceRoot: input.workspaceRoot,
      model: input.model,
      modelRuntime: input.modelRuntime,
      systemPrompt:
        input.systemPrompt ??
        `You are a ${input.role} researcher. Use only read tools (ls, find, grep, read). Do not write files. Return a concise evidence summary with source paths.`,
      sourceIgnores: input.sourceIgnores,
      // Children never write — scoped tools still apply read guards.
      scopedTools: true,
    });

    let text = "";
    const unsub = handle.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        text += event.assistantMessageEvent.delta ?? "";
      }
    });

    try {
      await handle.session.prompt(input.task);
    } finally {
      unsub();
    }

    return {
      role: input.role,
      mode: "live",
      summary: text.trim() || `(${input.role} completed with empty summary)`,
    };
  } finally {
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

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
