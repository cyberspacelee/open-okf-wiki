/**
 * Host-driven parent Session tool for wiki produce (Pi official tool shape).
 *
 * Matches agent-loop tool lifecycle:
 *   tool_execution_start → tool_execution_update (onUpdate) → tool_execution_end
 *   + appendMessage(assistant toolCall) / appendMessage(toolResult)
 *
 * Not an LLM-chosen tool call — start_wiki_run owns invocation — but events and
 * JSONL are the same framework shapes so UI cold/hot paths stay Pi-native.
 */

import { randomUUID } from "node:crypto";
import type { ProduceToolDetails } from "./wiki-produce-progress.js";

/** Tool name visible on the Operator Session timeline. */
export const WIKI_PRODUCE_TOOL_NAME = "wiki_produce" as const;

/** Minimal SessionManager surface (append only). */
export type ParentToolSessionManager = {
  appendMessage(message: unknown): string;
};

/**
 * Emit Pi-shaped events (same objects AgentSession.subscribe would forward).
 * Server wires this to emitPi(workspaceId, sessionId, event.type, event).
 */
export type ParentToolEventEmit = (event: Record<string, unknown>) => void;

export type BeginParentWikiProduceToolOpts = {
  sessionManager: ParentToolSessionManager;
  emit: ParentToolEventEmit;
  runId: string;
  /** Optional extra args stored on the toolCall block. */
  args?: Record<string, unknown>;
  /** Stable id; default wiki_produce_<runId> or uuid. */
  toolCallId?: string;
};

export type ParentWikiProduceToolHandle = {
  toolCallId: string;
  toolName: typeof WIKI_PRODUCE_TOOL_NAME;
  /**
   * Stream partial tool result (Pi onUpdate → tool_execution_update).
   * Pass aggregated ProduceToolDetails tree for operator cards.
   */
  onUpdate: (details: ProduceToolDetails) => void;
  /** Finalize toolResult message + tool_execution_end. */
  complete: (opts: {
    details: ProduceToolDetails;
    isError?: boolean;
    summaryText?: string;
  }) => void;
};

function textFromDetails(details: ProduceToolDetails): string {
  if (details.summary?.trim()) return details.summary.trim();
  if (details.error?.trim()) return details.error.trim();
  if (details.task?.trim()) return `${details.role}: ${details.task.trim()}`;
  return `${details.role} (${details.status})`;
}

function partialResult(details: ProduceToolDetails): {
  content: Array<{ type: "text"; text: string }>;
  details: ProduceToolDetails;
} {
  return {
    content: [{ type: "text", text: textFromDetails(details) }],
    details,
  };
}

/**
 * Open a parent-visible wiki_produce tool row on the Operator Session.
 * Call onUpdate during produce; complete when the run segment settles.
 */
export function beginParentWikiProduceTool(
  opts: BeginParentWikiProduceToolOpts,
): ParentWikiProduceToolHandle {
  const toolCallId =
    opts.toolCallId?.trim() || `wiki_produce_${opts.runId}`.slice(0, 120) || randomUUID();
  const args: Record<string, unknown> = {
    runId: opts.runId,
    ...(opts.args ?? {}),
  };
  const ts = Date.now();

  const assistantMessage = {
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id: toolCallId,
        name: WIKI_PRODUCE_TOOL_NAME,
        arguments: args,
      },
    ],
    api: "okf-host",
    provider: "okf",
    model: "wiki_produce",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse" as const,
    timestamp: ts,
  };

  try {
    opts.sessionManager.appendMessage(assistantMessage);
  } catch {
    // still emit live events even if persistence fails
  }

  opts.emit({ type: "message_start", message: assistantMessage });
  opts.emit({ type: "message_end", message: assistantMessage });
  opts.emit({
    type: "tool_execution_start",
    toolCallId,
    toolName: WIKI_PRODUCE_TOOL_NAME,
    args,
  });

  let completed = false;

  const onUpdate = (details: ProduceToolDetails): void => {
    if (completed) return;
    const partial = partialResult(details);
    opts.emit({
      type: "tool_execution_update",
      toolCallId,
      toolName: WIKI_PRODUCE_TOOL_NAME,
      args,
      partialResult: partial,
    });
  };

  const complete = (end: {
    details: ProduceToolDetails;
    isError?: boolean;
    summaryText?: string;
  }): void => {
    if (completed) return;
    completed = true;
    const isError = end.isError === true || end.details.status === "failed";
    const text =
      end.summaryText?.trim() ||
      textFromDetails(end.details) ||
      (isError ? "wiki_produce failed" : "wiki_produce complete");
    const result = {
      content: [{ type: "text" as const, text }],
      details: end.details,
    };
    const toolResultMessage = {
      role: "toolResult" as const,
      toolCallId,
      toolName: WIKI_PRODUCE_TOOL_NAME,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    };
    try {
      opts.sessionManager.appendMessage(toolResultMessage);
    } catch {
      // best-effort durability
    }
    opts.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: WIKI_PRODUCE_TOOL_NAME,
      result,
      isError,
    });
    opts.emit({ type: "message_start", message: toolResultMessage });
    opts.emit({ type: "message_end", message: toolResultMessage });
  };

  return { toolCallId, toolName: WIKI_PRODUCE_TOOL_NAME, onUpdate, complete };
}
