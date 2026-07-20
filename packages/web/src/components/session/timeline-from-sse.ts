import type { RunSseEvent } from "../../api";
import type { SessionTimelineItem, ToolPartState } from "./types";

const MAX_ITEMS = 200;

function isToolState(value: unknown): value is ToolPartState {
  return (
    value === "input-streaming" ||
    value === "input-available" ||
    value === "output-available" ||
    value === "output-error"
  );
}

/**
 * Fold SSE events into a Session timeline.
 * Text deltas are merged into one markdown blob.
 * Tool call + tool_result with the same toolCallId are merged into one card.
 */
export function reduceSseToTimeline(
  prev: SessionTimelineItem[],
  event: RunSseEvent,
): SessionTimelineItem[] {
  const id = `${event.runId}-${event.sequence}`;

  if (event.type === "text" && (event.text || event.message)) {
    const chunk = event.text ?? event.message ?? "";
    const last = prev[prev.length - 1];
    if (last && last.kind === "text") {
      const merged = prev.slice(0, -1);
      const nextItem: SessionTimelineItem = {
        kind: "text",
        id: last.id,
        text: last.text + chunk,
        nodeId: last.nodeId,
      };
      return [...merged, nextItem].slice(-MAX_ITEMS);
    }
    const item: SessionTimelineItem = {
      kind: "text",
      id,
      text: chunk,
      nodeId: event.nodeId,
    };
    return [...prev, item].slice(-MAX_ITEMS);
  }

  if (event.type === "tool") {
    const toolName = event.toolName ?? event.partType?.replace(/^tool-/, "") ?? "tool";
    const toolCallId = event.toolCallId;
    if (toolCallId) {
      const idx = prev.findIndex(
        (item) => item.kind === "tool" && item.toolCallId === toolCallId,
      );
      if (idx >= 0) {
        const existing = prev[idx]!;
        if (existing.kind === "tool") {
          const next = [...prev];
          next[idx] = {
            kind: "tool",
            id: existing.id,
            toolName: existing.toolName,
            toolCallId: existing.toolCallId,
            toolState: isToolState(event.toolState) ? event.toolState : existing.toolState,
            inputSummary: event.inputSummary ?? existing.inputSummary,
            outputSummary: existing.outputSummary,
            nodeId: event.nodeId ?? existing.nodeId,
          };
          return next;
        }
      }
    }
    const item: SessionTimelineItem = {
      kind: "tool",
      id,
      toolName,
      toolCallId,
      toolState: isToolState(event.toolState) ? event.toolState : "input-available",
      inputSummary: event.inputSummary,
      nodeId: event.nodeId,
    };
    return [...prev, item].slice(-MAX_ITEMS);
  }

  if (event.type === "tool_result") {
    const toolCallId = event.toolCallId;
    if (toolCallId) {
      const idx = prev.findIndex(
        (item) => item.kind === "tool" && item.toolCallId === toolCallId,
      );
      if (idx >= 0) {
        const existing = prev[idx]!;
        if (existing.kind === "tool") {
          const next = [...prev];
          next[idx] = {
            kind: "tool",
            id: existing.id,
            toolName: existing.toolName,
            toolCallId: existing.toolCallId,
            toolState: isToolState(event.toolState)
              ? event.toolState
              : "output-available",
            inputSummary: existing.inputSummary,
            outputSummary: event.outputSummary ?? existing.outputSummary,
            nodeId: event.nodeId ?? existing.nodeId,
          };
          return next;
        }
      }
    }
    const toolName = event.toolName ?? "tool";
    const item: SessionTimelineItem = {
      kind: "tool",
      id,
      toolName,
      toolCallId,
      toolState: isToolState(event.toolState) ? event.toolState : "output-available",
      outputSummary: event.outputSummary,
      nodeId: event.nodeId,
    };
    return [...prev, item].slice(-MAX_ITEMS);
  }

  if (event.type === "status" || event.type === "log" || event.type === "error") {
    const message = event.message ?? event.status ?? event.type;
    const item: SessionTimelineItem = {
      kind: "status",
      id,
      message,
      status: event.status,
    };
    return [...prev, item].slice(-MAX_ITEMS);
  }

  if (event.message) {
    const item: SessionTimelineItem = {
      kind: "status",
      id,
      message: event.message,
      status: event.status,
    };
    return [...prev, item].slice(-MAX_ITEMS);
  }

  return prev;
}
