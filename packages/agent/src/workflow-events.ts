/**
 * Map framework UI stream chunks → product Run console job events.
 *
 * Live Run SSE no longer hand-maps Mastra workflow-start/step events
 * (ADR 0027 Phase 6). Prefer toAISdkStream / workflowSnapshotToStream chunks.
 */

import type { UIMessageChunk } from "ai";

export type WikiWorkflowJobEvent = {
  type: "log" | "part";
  message: string;
  partType?: string;
  text?: string;
  nodeId?: string;
};

function truncate(text: string, max = 500): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Convert one AI SDK UIMessageChunk (from toAISdkStream / workflowSnapshotToStream)
 * into a Run console job event. Returns null for noisy protocol-only chunks.
 */
export function uiChunkToJobEvent(
  chunk: unknown,
): WikiWorkflowJobEvent | null {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const c = chunk as UIMessageChunk & {
    type?: string;
    delta?: string;
    text?: string;
    id?: string;
    toolName?: string;
    toolCallId?: string;
    data?: unknown;
  };
  const type = c.type ?? "";

  if (type === "text-delta" || type === "reasoning-delta") {
    const delta =
      typeof c.delta === "string"
        ? c.delta
        : typeof c.text === "string"
          ? c.text
          : "";
    if (!delta.trim()) {
      return null;
    }
    return {
      type: "part",
      partType: type.startsWith("reasoning") ? "reasoning" : "text",
      message: truncate(delta.trim(), 200),
      text: truncate(delta, 8000),
      nodeId: "workflow",
    };
  }

  if (type === "text-start" || type === "text-end") {
    return null;
  }
  if (type === "reasoning-start" || type === "reasoning-end") {
    return null;
  }
  if (type === "start" || type === "finish" || type === "start-step" || type === "finish-step") {
    return {
      type: "log",
      message: `workflow: ${type}`,
      nodeId: "workflow",
    };
  }

  if (typeof type === "string" && type.startsWith("tool-")) {
    const toolName =
      typeof c.toolName === "string"
        ? c.toolName
        : type.replace(/^tool-/, "") || "tool";
    return {
      type: "part",
      partType: type,
      message: toolName,
      nodeId: "workflow",
    };
  }

  if (typeof type === "string" && type.startsWith("data-")) {
    const summary =
      c.data && typeof c.data === "object"
        ? truncate(JSON.stringify(c.data), 300)
        : type;
    return {
      type: "part",
      partType: type,
      message: summary,
      text:
        c.data !== undefined
          ? truncate(
              typeof c.data === "string" ? c.data : JSON.stringify(c.data),
              8000,
            )
          : undefined,
      nodeId: "workflow",
    };
  }

  if (type === "error") {
    const msg =
      typeof (c as { errorText?: string }).errorText === "string"
        ? (c as { errorText: string }).errorText
        : "workflow error";
    return {
      type: "log",
      message: truncate(msg, 500),
      nodeId: "workflow",
    };
  }

  // Drop high-volume / unknown protocol noise.
  if (
    type.includes("delta") ||
    type.includes("tool-input") ||
    type.includes("tool-output")
  ) {
    return null;
  }

  if (type) {
    return {
      type: "log",
      message: `workflow: ${type}`,
      nodeId: "workflow",
    };
  }
  return null;
}

/**
 * @deprecated Use {@link uiChunkToJobEvent} on framework UI chunks.
 * Kept as a thin alias that only accepts UI chunks (legacy name for imports).
 */
export function mapWorkflowStreamEvent(
  event: unknown,
): WikiWorkflowJobEvent | null {
  // If it looks like a Mastra raw workflow event (type workflow-*), drop —
  // live path must use toAISdkStream first.
  if (
    event &&
    typeof event === "object" &&
    typeof (event as { type?: string }).type === "string" &&
    String((event as { type: string }).type).startsWith("workflow-")
  ) {
    const type = (event as { type: string }).type;
    if (type === "workflow-start" || type === "start") {
      return { type: "log", message: "wiki workflow running", nodeId: "workflow" };
    }
    if (type === "workflow-finish" || type === "finish") {
      return {
        type: "log",
        message: "wiki workflow finished",
        nodeId: "workflow",
      };
    }
    if (type === "workflow-step-start") {
      return {
        type: "log",
        message: "workflow step started",
        nodeId: "workflow",
      };
    }
    if (type === "workflow-step-suspended") {
      return {
        type: "log",
        message: "workflow suspended (hitl)",
        nodeId: "workflow",
      };
    }
    return null;
  }
  return uiChunkToJobEvent(event);
}
