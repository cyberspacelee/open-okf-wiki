/**
 * Mid-stream UI chunk accumulation + pipe into SessionTurn writer.
 * Operator projection only — model fidelity stays inside Mastra.
 */

import type { UIMessageChunk } from "ai";
import type { SessionMessage } from "@okf-wiki/contract";
import {
  projectSessionToolPart,
  projectToolOutputChunk,
  projectUiMessageChunk,
} from "../ui-projection.js";

/** Accumulator for mid-stream durable checkpoints (refresh mid-flight). */
export type StreamPartAcc = {
  textById: Map<string, string>;
  toolParts: Map<string, SessionMessage["parts"][number]>;
  /** toolCallId → toolName for output projection when chunk omits name */
  toolNames: Map<string, string>;
  dataParts: SessionMessage["parts"];
};

export function createStreamPartAcc(): StreamPartAcc {
  return {
    textById: new Map(),
    toolParts: new Map(),
    toolNames: new Map(),
    dataParts: [],
  };
}

/**
 * Project a chunk for operator UI + durable Session (not model fidelity).
 * Resolves toolName for tool-output-available from prior input chunks.
 */
export function projectChunkForSession(
  acc: StreamPartAcc,
  value: UIMessageChunk,
): UIMessageChunk {
  const v = value as UIMessageChunk & Record<string, unknown>;
  if (v.type === "tool-input-available") {
    const toolCallId = String(v.toolCallId ?? "tool");
    const toolName = String(v.toolName ?? "tool");
    acc.toolNames.set(toolCallId, toolName);
    return projectUiMessageChunk(value);
  }
  if (v.type === "tool-output-available") {
    const toolCallId = String(v.toolCallId ?? "tool");
    const toolName =
      (typeof v.toolName === "string" && v.toolName) ||
      acc.toolNames.get(toolCallId) ||
      "tool";
    return projectToolOutputChunk(value, toolName);
  }
  return projectUiMessageChunk(value);
}

export function applyChunkToAcc(acc: StreamPartAcc, value: UIMessageChunk): void {
  const projected = projectChunkForSession(acc, value);
  const v = projected as UIMessageChunk & Record<string, unknown>;
  switch (v.type) {
    case "text-delta": {
      const id = String(v.id ?? "text");
      const delta = typeof v.delta === "string" ? v.delta : "";
      acc.textById.set(id, (acc.textById.get(id) ?? "") + delta);
      break;
    }
    case "tool-input-available": {
      const toolCallId = String(v.toolCallId ?? "tool");
      const toolName = String(v.toolName ?? acc.toolNames.get(toolCallId) ?? "tool");
      acc.toolNames.set(toolCallId, toolName);
      acc.toolParts.set(
        toolCallId,
        projectSessionToolPart({
          type: `tool-${toolName}`,
          toolCallId,
          toolName,
          state: "input-available",
          input: v.input,
        } as SessionMessage["parts"][number]),
      );
      break;
    }
    case "tool-output-available": {
      const toolCallId = String(v.toolCallId ?? "tool");
      const prev = acc.toolParts.get(toolCallId) as
        | {
            type: string;
            toolCallId?: string;
            toolName?: string;
            input?: unknown;
          }
        | undefined;
      const toolName =
        prev?.toolName ??
        acc.toolNames.get(toolCallId) ??
        (prev?.type?.startsWith("tool-") ? prev.type.slice(5) : "tool");
      acc.toolNames.set(toolCallId, toolName);
      acc.toolParts.set(
        toolCallId,
        projectSessionToolPart({
          type: `tool-${toolName}`,
          toolCallId,
          toolName,
          state: "output-available",
          input: prev?.input,
          output: v.output,
        } as SessionMessage["parts"][number]),
      );
      break;
    }
    default: {
      if (typeof v.type === "string" && v.type.startsWith("data-")) {
        acc.dataParts.push({
          type: v.type,
          id: typeof v.id === "string" ? v.id : undefined,
          data: v.data,
        } as SessionMessage["parts"][number]);
      }
      break;
    }
  }
}

export function partsFromAcc(
  productText: string,
  productData: SessionMessage["parts"],
  productTools: SessionMessage["parts"],
  acc: StreamPartAcc,
): SessionMessage["parts"] {
  const parts: SessionMessage["parts"] = [];
  const streamedText = [...acc.textById.values()].join("");
  const text = [productText, streamedText].filter(Boolean).join("\n\n");
  if (text) {
    parts.push({ type: "text", text, state: "streaming" });
  } else {
    parts.push({
      type: "text",
      text: "Wiki Run in progress… (refresh will update as work continues)",
      state: "streaming",
    });
  }
  parts.push(...productData);
  parts.push(...productTools);
  parts.push(...acc.dataParts);
  parts.push(...acc.toolParts.values());
  return parts;
}

function projectLiveChunk(
  toolNames: Map<string, string>,
  value: UIMessageChunk,
): UIMessageChunk {
  const v = value as UIMessageChunk & Record<string, unknown>;
  if (v.type === "tool-input-available") {
    const toolCallId = String(v.toolCallId ?? "tool");
    const toolName = String(v.toolName ?? "tool");
    toolNames.set(toolCallId, toolName);
    return projectUiMessageChunk(value);
  }
  if (v.type === "tool-output-available") {
    const toolCallId = String(v.toolCallId ?? "tool");
    const toolName =
      (typeof v.toolName === "string" && v.toolName) ||
      toolNames.get(toolCallId) ||
      "tool";
    return projectToolOutputChunk(value, toolName);
  }
  return projectUiMessageChunk(value);
}

/**
 * Pipe another UI stream into the turn writer (awaited for ordering).
 * Skip nested start/finish — the outer createUIMessageStream owns message framing
 * (with originalMessages) so we do not open a second assistant bubble.
 * When `abortSignal` fires, cancel the reader so we stop merging chunks ASAP.
 * Optional `onChunk` supports durable mid-stream checkpoints for refresh.
 */
export async function pipeUiStream(
  writer: { write: (part: UIMessageChunk) => void },
  stream: ReadableStream<UIMessageChunk>,
  abortSignal?: AbortSignal,
  onChunk?: (chunk: UIMessageChunk) => void | Promise<void>,
  /**
   * Optional name map shared with durable acc so live stream and checkpoint
   * use the same toolName when projecting tool-output-available.
   */
  toolNames?: Map<string, string>,
): Promise<void> {
  const reader = stream.getReader();
  const names = toolNames ?? new Map<string, string>();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (abortSignal?.aborted) {
    await reader.cancel().catch(() => undefined);
    return;
  }
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (abortSignal?.aborted) {
        break;
      }
      let done: boolean;
      let value: UIMessageChunk | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        // reader.cancel() from product abort rejects a pending read — treat as
        // clean stop so the caller can still await workflow result() (durable
        // publish must not be lost to a stream cancel error).
        break;
      }
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      if (value.type === "start" || value.type === "finish") {
        continue;
      }
      // Drop further writes once product cancel wins mid-pipe.
      if (abortSignal?.aborted) {
        break;
      }
      // Operator projection only — model fidelity stays inside Mastra.
      const projected = projectLiveChunk(names, value);
      writer.write(projected);
      try {
        await onChunk?.(projected);
      } catch {
        // checkpoint must never break the live stream
      }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    // Ensure the underlying workflow stream is not left locked if we broke early.
    try {
      await reader.cancel();
    } catch {
      // already cancelled / closed
    }
  }
}
