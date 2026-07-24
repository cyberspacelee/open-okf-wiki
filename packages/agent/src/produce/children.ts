/**
 * In-process Pi child sessions for Domain / Leaf / Reviewer / Plan (ADR 0030).
 * Prefer SDK embedding over spawning the `pi` CLI.
 *
 * Provider failures often complete session.prompt() without throwing
 * (stopReason "error"). We fail closed instead of inventing empty success.
 *
 * Child events stay inside the child Session. Operator visibility is only via
 * parent wiki_produce tool details (`onProgress` → details.children), never
 * as Operator Session messages (ADR 0032).
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WikiProduceChildItem, WikiProduceChildSpan } from "@okf-wiki/contract";
import { resolveAssistantSummary } from "../pi/assistant-outcome.js";
import { createWikiSession, type WikiSessionHandle } from "../pi/create-wiki-session.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import type { WikiAgentRole } from "../pi/tool-policy.js";
import { shouldUsePiFixtureMode } from "./live-pi.js";

export type ChildRole = Extract<
  WikiAgentRole,
  "domain" | "leaf" | "reviewer" | "root_research" | "plan" | "root_write"
>;

const MAX_ITEMS = 20;
const MAX_TEXT_CHUNK = 2000;
const MAX_ARGS_SUMMARY = 500;

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
  /** Stable id for parent tool details.children (defaults to role). */
  spanId?: string;
  /** Progressive projection for parent wiki_produce onUpdate (not Session JSONL). */
  onProgress?: (span: WikiProduceChildSpan) => void;
};

export type RunChildSessionResult = {
  role: ChildRole;
  summary: string;
  mode: "fixture" | "live";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function argsSummary(args: unknown): string | undefined {
  if (args == null) return undefined;
  try {
    const raw = typeof args === "string" ? args : JSON.stringify(args);
    return truncate(raw, MAX_ARGS_SUMMARY);
  } catch {
    return undefined;
  }
}

function pushItem(items: WikiProduceChildItem[], item: WikiProduceChildItem): void {
  if (item.type === "text" && items.length > 0) {
    const last = items[items.length - 1];
    if (last?.type === "text") {
      items[items.length - 1] = {
        type: "text",
        text: truncate(last.text + item.text, MAX_TEXT_CHUNK * 2),
      };
      return;
    }
  }
  items.push(item);
  while (items.length > MAX_ITEMS) items.shift();
}

function emitProgress(
  onProgress: RunChildSessionInput["onProgress"],
  span: WikiProduceChildSpan,
): void {
  try {
    onProgress?.(span);
  } catch {
    // Display must not break the child run.
  }
}

/**
 * Run a child agent (usually read-only research/review/plan).
 * Always uses role allowlist (no bash).
 */
export async function runChildSession(input: RunChildSessionInput): Promise<RunChildSessionResult> {
  const spanId = input.spanId?.trim() || input.role;
  const role = input.role === "root_write" ? "root_write" : input.role;

  if (input.abortSignal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    emitProgress(input.onProgress, {
      id: spanId,
      role,
      status: "cancelled",
      summary: "Wiki Run cancelled",
    });
    throw err;
  }

  // Explicit fixture only (arg or non-production OKF_WIKI_AGENT_MODE=fixture).
  if (shouldUsePiFixtureMode({ fixture: input.fixture })) {
    const summary = `[fixture ${input.role}] ${input.task.slice(0, 200)}`;
    emitProgress(input.onProgress, {
      id: spanId,
      role,
      status: "done",
      summary,
      items: [{ type: "text", text: summary }],
    });
    return {
      role: input.role,
      mode: "fixture",
      summary,
    };
  }

  if (!input.model) {
    throw new Error(
      `Child session (${input.role}) live mode requires a model, or pass fixture: true / OKF_WIKI_AGENT_MODE=fixture for smoke only (ignored when NODE_ENV=production)`,
    );
  }

  // createWikiSession roles exclude root_write in some paths — map for session factory.
  const sessionRole: WikiAgentRole =
    input.role === "root_write" ? "root_write" : input.role === "plan" ? "plan" : input.role;

  let handle: WikiSessionHandle | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try {
      handle?.session.abort();
    } catch {
      // best-effort
    }
  };

  const items: WikiProduceChildItem[] = [];
  let turns = 0;
  let contextTokens: number | undefined;
  const toolStatus = new Map<string, "running" | "done" | "error">();

  const snapshot = (status: WikiProduceChildSpan["status"], summary?: string): WikiProduceChildSpan => ({
    id: spanId,
    role,
    status,
    ...(summary ? { summary: truncate(summary, 4000) } : {}),
    ...(items.length > 0 ? { items: items.slice(-MAX_ITEMS) } : {}),
    usage: {
      turns,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
    },
  });

  try {
    emitProgress(input.onProgress, snapshot("running", `${input.role} started`));

    handle = await createWikiSession({
      role: sessionRole,
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
        emitProgress(input.onProgress, snapshot("cancelled", "Wiki Run cancelled"));
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
      const raw = event as unknown;
      if (!isRecord(raw)) return;

      if (kind === "message_update") {
        const ame = isRecord(raw.assistantMessageEvent) ? raw.assistantMessageEvent : null;
        if (!ame) return;
        if (ame.type === "text_delta" && typeof ame.delta === "string") {
          text += ame.delta;
          pushItem(items, { type: "text", text: truncate(ame.delta, MAX_TEXT_CHUNK) });
          emitProgress(input.onProgress, snapshot("running"));
        }
        return;
      }

      if (kind === "message_end") {
        const message = isRecord(raw.message) ? raw.message : null;
        if (message && message.role === "assistant") {
          turns += 1;
          if (isRecord(message.usage)) {
            const total = message.usage.totalTokens;
            if (typeof total === "number" && total >= 0) contextTokens = total;
          }
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (!isRecord(block) || block.type !== "toolCall") continue;
              const name = typeof block.name === "string" ? block.name : "tool";
              const id = typeof block.id === "string" ? block.id : name;
              const args = "arguments" in block ? block.arguments : block.args;
              toolStatus.set(id, "running");
              pushItem(items, {
                type: "toolCall",
                name,
                argsSummary: argsSummary(args),
                status: "running",
              });
            }
          }
          emitProgress(input.onProgress, snapshot("running"));
        }
        return;
      }

      if (kind === "tool_execution_start") {
        const name = typeof raw.toolName === "string" ? raw.toolName : "tool";
        const id = typeof raw.toolCallId === "string" ? raw.toolCallId : name;
        toolStatus.set(id, "running");
        pushItem(items, {
          type: "toolCall",
          name,
          argsSummary: argsSummary(raw.args ?? raw.input),
          status: "running",
        });
        emitProgress(input.onProgress, snapshot("running"));
        return;
      }

      if (kind === "tool_execution_end") {
        const name = typeof raw.toolName === "string" ? raw.toolName : "tool";
        const id = typeof raw.toolCallId === "string" ? raw.toolCallId : name;
        const isError = raw.isError === true;
        toolStatus.set(id, isError ? "error" : "done");
        // Update last matching running toolCall if present
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it?.type === "toolCall" && it.name === name && it.status === "running") {
            items[i] = { ...it, status: isError ? "error" : "done" };
            break;
          }
        }
        emitProgress(input.onProgress, snapshot("running"));
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
      emitProgress(input.onProgress, snapshot("cancelled", "Wiki Run cancelled"));
      throw err;
    }

    const resolved = resolveAssistantSummary({
      streamedText: text,
      messages: handle.session.messages,
      roleLabel: input.role,
    });
    if (resolved.isError) {
      emitProgress(
        input.onProgress,
        snapshot("error", resolved.errorMessage ?? resolved.summary),
      );
      throw new Error(
        `Child session (${input.role}) failed: ${resolved.errorMessage ?? resolved.summary}`,
      );
    }

    emitProgress(input.onProgress, snapshot("done", resolved.summary));
    return {
      role: input.role,
      mode: "live",
      summary: resolved.summary,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    const message = err instanceof Error ? err.message : String(err);
    emitProgress(input.onProgress, snapshot("error", message));
    throw err;
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
